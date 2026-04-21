/**
 * DarkSelect — custom dark-themed dropdown that wraps a native <select>.
 * Hides the native control, mounts a styled trigger + popup with the same
 * options, and writes selections back to the original <select> so existing
 * `change` listeners and form-value reads continue to work unchanged.
 */
export class DarkSelect {
    constructor(select) {
        this.select = select;
        // Flatten direct children into an items list of
        // { type: 'header' | 'option', label, value?, disabled? }
        // so we preserve <optgroup> structure in the rendered popup.
        this.items = [];
        this.options = []; // option-only convenience list for value→label lookup
        Array.from(select.children).forEach(child => {
            if (child.tagName === 'OPTGROUP') {
                this.items.push({ type: 'header', label: child.label });
                Array.from(child.children).forEach(o => {
                    const item = { type: 'option', value: o.value, label: o.textContent, disabled: o.disabled };
                    this.items.push(item);
                    this.options.push(item);
                });
            } else if (child.tagName === 'OPTION') {
                const item = { type: 'option', value: child.value, label: child.textContent, disabled: child.disabled };
                this.items.push(item);
                this.options.push(item);
            }
        });
        this.value = select.value;
        this.isOpen = false;
        this.outsideClickHandler = (e) => {
            if (!this.wrapper.contains(e.target)) this.close();
        };
        this.keyHandler = (e) => {
            if (!this.isOpen) return;
            if (e.key === 'Escape') { this.close(); this.trigger.focus(); }
        };
        this.build();
    }

    build() {
        this.wrapper = document.createElement('div');
        this.wrapper.className = 'dark-select';

        // Trigger button shows the selected option's label
        this.trigger = document.createElement('button');
        this.trigger.type = 'button';
        this.trigger.className = 'dark-select-trigger';
        this.trigger.innerHTML = `
            <span class="dark-select-label"></span>
            <i class="fas fa-chevron-down dark-select-chevron" aria-hidden="true"></i>
        `;
        this.trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggle();
        });

        this.popup = document.createElement('div');
        this.popup.className = 'dark-select-popup';
        this.popup.hidden = true;
        this.popup.addEventListener('click', (e) => e.stopPropagation());

        // Insert wrapper next to the native select, then move the select inside
        this.select.insertAdjacentElement('afterend', this.wrapper);
        this.wrapper.appendChild(this.trigger);
        this.wrapper.appendChild(this.popup);
        this.wrapper.appendChild(this.select);

        // Hide the native select but keep it functional for form data
        this.select.style.display = 'none';

        this.renderOptions();
        this.updateTrigger();
    }

    renderOptions() {
        this.popup.innerHTML = this.items.map(item => {
            if (item.type === 'header') {
                return `<div class="dark-select-group-label">${item.label}</div>`;
            }
            return `
                <button type="button"
                    class="dark-select-option ${item.value === this.value ? 'selected' : ''} ${item.disabled ? 'disabled' : ''}"
                    data-value="${item.value}"
                    ${item.disabled ? 'disabled' : ''}>
                    <span>${item.label}</span>
                    ${item.value === this.value ? '<i class="fas fa-check dark-select-check"></i>' : ''}
                </button>
            `;
        }).join('');
        this.popup.querySelectorAll('.dark-select-option').forEach(btn => {
            btn.addEventListener('click', () => {
                if (btn.disabled) return;
                this.setValue(btn.dataset.value);
                this.close();
            });
        });
    }

    updateTrigger() {
        const opt = this.options.find(o => o.value === this.value) || this.options[0];
        const label = this.trigger.querySelector('.dark-select-label');
        if (label) label.textContent = opt ? opt.label : '';
        // Mark the trigger as "placeholder" if the value is empty (for nicer styling)
        this.wrapper.classList.toggle('is-placeholder', !this.value);
    }

    setValue(value) {
        if (value === this.value) return;
        this.value = value;
        this.select.value = value;
        this.select.dispatchEvent(new Event('change', { bubbles: true }));
        this.renderOptions();
        this.updateTrigger();
    }

    /** Re-sync from the underlying select (e.g. after view re-render sets value programmatically). */
    sync() {
        if (this.select.value !== this.value) {
            this.value = this.select.value;
            this.renderOptions();
            this.updateTrigger();
        }
    }

    toggle() { this.isOpen ? this.close() : this.open(); }

    open() {
        // Only one DarkSelect popup may be open at a time
        if (DarkSelect._activeInstance && DarkSelect._activeInstance !== this) {
            DarkSelect._activeInstance.close();
        }
        DarkSelect._activeInstance = this;

        this.isOpen = true;
        this.popup.hidden = false;
        this.wrapper.classList.add('is-open');

        // Scroll selected option into view if any
        const selectedEl = this.popup.querySelector('.dark-select-option.selected');
        if (selectedEl) {
            requestAnimationFrame(() => selectedEl.scrollIntoView({ block: 'nearest' }));
        }

        setTimeout(() => {
            document.addEventListener('click', this.outsideClickHandler);
            document.addEventListener('keydown', this.keyHandler);
        }, 0);
    }

    close() {
        if (!this.isOpen) return;
        this.isOpen = false;
        this.popup.hidden = true;
        this.wrapper.classList.remove('is-open');
        if (DarkSelect._activeInstance === this) DarkSelect._activeInstance = null;
        document.removeEventListener('click', this.outsideClickHandler);
        document.removeEventListener('keydown', this.keyHandler);
    }
}
