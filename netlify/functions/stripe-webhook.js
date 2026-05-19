/*
 * Stripe -> Firestore webhook for Brain Arena premium.
 *
 * Stripe Checkout (one-time $5) redirects the buyer to success.html and
 * fires `checkout.session.completed` at this endpoint. We verify the
 * signature, then flip users/{uid}.triviaProfile.premium=true via the
 * Firebase Admin SDK (which bypasses Firestore rules).
 *
 * Endpoint URL after deploy:
 *   https://<your-site>/.netlify/functions/stripe-webhook
 * Configure that URL in Stripe Dashboard -> Developers -> Webhooks,
 * subscribed to `checkout.session.completed`. Copy the signing secret
 * into Netlify env vars as STRIPE_WEBHOOK_SECRET.
 *
 * Required Netlify env vars:
 *   STRIPE_SECRET_KEY           - sk_live_... or sk_test_... (Secret API key)
 *   STRIPE_WEBHOOK_SECRET       - whsec_... from the webhook signing secret
 *   FIREBASE_SERVICE_ACCOUNT    - the entire service-account JSON, single line
 *                                 (Firebase Console -> Project settings ->
 *                                  Service accounts -> Generate new key)
 *
 * The Stripe Payment Link must be configured to pass `client_reference_id`
 * along — Brain Arena's checkout button appends it as a URL param so
 * Stripe attaches the Firebase uid to the session.
 */
'use strict';

const Stripe = require('stripe');
const admin = require('firebase-admin');

let adminApp;

function getAdminApp() {
    if (adminApp) return adminApp;
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT env var is missing');
    const credentials = JSON.parse(raw);
    adminApp = admin.initializeApp({
        credential: admin.credential.cert(credentials)
    });
    return adminApp;
}

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method not allowed' };
    }

    const secretKey = process.env.STRIPE_SECRET_KEY;
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secretKey || !webhookSecret) {
        console.error('Stripe env vars not configured');
        return { statusCode: 500, body: 'server misconfigured' };
    }

    const stripe = new Stripe(secretKey);
    const signature = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];

    // Netlify decodes the body when isBase64Encoded is false. Stripe
    // signature verification requires the EXACT raw payload bytes — so
    // when Netlify base64-encoded it, decode back to a Buffer.
    const rawBody = event.isBase64Encoded
        ? Buffer.from(event.body, 'base64')
        : event.body;

    let stripeEvent;
    try {
        stripeEvent = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    } catch (err) {
        console.error('Stripe signature verification failed:', err.message);
        return { statusCode: 400, body: `Webhook Error: ${err.message}` };
    }

    if (stripeEvent.type !== 'checkout.session.completed') {
        return { statusCode: 200, body: 'ignored' };
    }

    const session = stripeEvent.data.object;
    const uid = session.client_reference_id;
    if (!uid) {
        console.warn('checkout.session.completed missing client_reference_id, session=', session.id);
        return { statusCode: 200, body: 'no client_reference_id' };
    }

    // Only flip premium for sessions that actually settled. Stripe sends
    // the event with payment_status='paid' for successful card / wallet
    // payments — but defer-pay methods could land here as 'unpaid' until
    // they clear, which we should not honour.
    if (session.payment_status && session.payment_status !== 'paid') {
        console.log(`session ${session.id} payment_status=${session.payment_status}, skipping`);
        return { statusCode: 200, body: 'payment not yet captured' };
    }

    const db = getAdminApp().firestore();
    await db.collection('users').doc(uid).set({
        triviaProfile: {
            premium: true,
            premiumPaidAt: admin.firestore.FieldValue.serverTimestamp(),
            stripeCheckoutSessionId: session.id,
            stripeCustomerEmail: session.customer_email || session.customer_details?.email || null,
            stripeAmountTotal: session.amount_total || null,
            stripeCurrency: session.currency || null
        }
    }, { merge: true });

    return { statusCode: 200, body: 'ok' };
};
