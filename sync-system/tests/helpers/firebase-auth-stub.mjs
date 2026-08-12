// Stands in for the Firebase Auth SDK under `node --test`.
//
// Only the three functions account deletion imports. Failures are injected by
// setting globalThis.__deletionFakes.reauthError / .deleteUserError to a
// Firebase-style error code, which is how the tests exercise the
// auth/requires-recent-login path without a real stale session.

function fakes() {
  return (globalThis.__deletionFakes ||= { calls: [], failures: {} });
}

function firebaseError(code) {
  const err = new Error(`Firebase: Error (${code}).`);
  err.code = code;
  return err;
}

export const EmailAuthProvider = {
  credential(email, password) {
    return { providerId: 'password', email, password };
  }
};

export async function reauthenticateWithCredential(user, credential) {
  const state = fakes();
  state.calls.push(`reauthenticate:${credential.email}:${credential.password}`);
  if (state.reauthError) throw firebaseError(state.reauthError);
  return { user };
}

export async function deleteUser(user) {
  const state = fakes();
  state.calls.push(`deleteUser:${user.uid}`);
  if (state.deleteUserError) throw firebaseError(state.deleteUserError);
}
