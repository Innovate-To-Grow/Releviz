(function () {
    if (window.I2GMaterialWebAdminInitialized) return;
    window.I2GMaterialWebAdminInitialized = true;

    var modules = [
        "https://esm.run/@material/web/textfield/outlined-text-field.js",
        "https://esm.run/@material/web/select/outlined-select.js",
        "https://esm.run/@material/web/select/select-option.js",
        "https://esm.run/@material/web/switch/switch.js",
        "https://esm.run/@material/web/checkbox/checkbox.js",
        "https://esm.run/@material/web/radio/radio.js",
    ];

    function dispatchNativeEvent(nativeField, type) {
        nativeField.dispatchEvent(new Event(type, { bubbles: true }));
    }

    function shouldSkipField(field) {
        if (!field || field.dataset.i2gMdSkip === "1") return true;
        if (field.closest("[data-i2g-md-skip]")) return true;
        if (field.closest(".i2g-md-field--enhanced")) return true;
        if (field.classList.contains("select2-hidden-accessible")) return true;
        if (field.classList.contains("admin-autocomplete")) return true;
        if (field.classList.contains("vForeignKeyRawIdAdminField")) return true;
        if (field.classList.contains("code-editor-field")) return true;
        if (field.classList.contains("django_ckeditor_5")) return true;
        if (field.closest(".CodeMirror")) return true;
        if (field.closest(".ck-editor")) return true;
        if (field.name === "manual_emails") return true;
        if (field.id === "id_body" && document.querySelector('input[name="body_format"]')) return true;
        if (field.type === "hidden" || field.type === "submit" || field.type === "button") return true;
        if (field.type === "reset" || field.type === "file" || field.type === "image") return true;
        if (field.type === "color" || field.type === "date" || field.type === "time") return true;
        if (field.tagName === "SELECT" && field.multiple) return true;
        return false;
    }

    function ensureWrapper(field) {
        if (field.parentElement && field.parentElement.matches("[data-i2g-md-field]")) {
            return field.parentElement;
        }

        var wrapper = document.createElement("span");
        wrapper.className = "i2g-md-field";
        wrapper.dataset.i2gMdField = "1";
        field.parentNode.insertBefore(wrapper, field);
        wrapper.appendChild(field);
        return wrapper;
    }

    function hideNativeField(field) {
        field.classList.add("i2g-md-field__native");
        field.tabIndex = -1;
        if (field.required) {
            field.dataset.i2gMdRequired = "1";
            field.required = false;
        }
    }

    function syncFormSubmit(nativeField, syncToNative) {
        if (!nativeField.form) return;
        nativeField.form.addEventListener("submit", syncToNative);
    }

    function getFieldLabel(nativeField) {
        if (!nativeField.id) return "";

        var label = document.querySelector('label[for="' + CSS.escape(nativeField.id) + '"]');
        if (!label) return "";

        return (label.textContent || "").replace(/\*/g, "").trim();
    }

    function enhanceTextField(nativeField) {
        var wrapper = ensureWrapper(nativeField);
        var materialField = wrapper.querySelector("md-outlined-text-field");

        if (!materialField) {
            materialField = document.createElement("md-outlined-text-field");
            materialField.className = "i2g-md-field__component";
            wrapper.appendChild(materialField);
        }

        materialField.type = nativeField.tagName === "TEXTAREA" ? "textarea" : nativeField.type || "text";
        materialField.value = nativeField.value || "";
        materialField.disabled = nativeField.disabled;
        materialField.required = nativeField.required;
        materialField.label = getFieldLabel(nativeField);
        materialField.placeholder = nativeField.getAttribute("placeholder") || "";

        if (nativeField.maxLength > 0) materialField.maxLength = nativeField.maxLength;
        if (nativeField.min) materialField.min = nativeField.min;
        if (nativeField.max) materialField.max = nativeField.max;
        if (nativeField.step) materialField.step = nativeField.step;
        if (nativeField.rows) materialField.rows = nativeField.rows;

        function syncToNative() {
            nativeField.value = materialField.value || "";
            dispatchNativeEvent(nativeField, "input");
            dispatchNativeEvent(nativeField, "change");
        }

        materialField.addEventListener("input", syncToNative);
        materialField.addEventListener("change", syncToNative);
        nativeField.addEventListener("change", function () {
            materialField.value = nativeField.value || "";
        });
        syncFormSubmit(nativeField, syncToNative);
        hideNativeField(nativeField);
        wrapper.classList.add("i2g-md-field--enhanced");
    }

    function enhanceSelect(nativeField) {
        var wrapper = ensureWrapper(nativeField);
        var materialField = document.createElement("md-outlined-select");
        materialField.className = "i2g-md-field__component";
        materialField.value = nativeField.value || "";
        materialField.disabled = nativeField.disabled;
        materialField.required = nativeField.required;
        materialField.label = getFieldLabel(nativeField);

        Array.from(nativeField.options).forEach(function (option) {
            var materialOption = document.createElement("md-select-option");
            materialOption.value = option.value;
            materialOption.disabled = option.disabled;
            materialOption.selected = option.selected;

            var headline = document.createElement("div");
            headline.slot = "headline";
            headline.textContent = option.textContent;
            materialOption.appendChild(headline);
            materialField.appendChild(materialOption);
        });

        function syncToNative() {
            nativeField.value = materialField.value || "";
            dispatchNativeEvent(nativeField, "change");
        }

        materialField.addEventListener("change", syncToNative);
        nativeField.addEventListener("change", function () {
            materialField.value = nativeField.value || "";
        });
        syncFormSubmit(nativeField, syncToNative);
        wrapper.appendChild(materialField);
        hideNativeField(nativeField);
        wrapper.classList.add("i2g-md-field--enhanced");
    }

    function enhanceToggle(nativeField) {
        var wrapper = ensureWrapper(nativeField);
        var isSwitch = nativeField.classList.contains("appearance-none") && nativeField.classList.contains("w-8");
        var materialField = document.createElement(isSwitch ? "md-switch" : "md-checkbox");
        materialField.className = "i2g-md-toggle__component";
        materialField.selected = nativeField.checked;
        materialField.checked = nativeField.checked;
        materialField.disabled = nativeField.disabled;

        function syncToNative() {
            nativeField.checked = isSwitch ? materialField.selected : materialField.checked;
            dispatchNativeEvent(nativeField, "change");
        }

        materialField.addEventListener("change", syncToNative);
        nativeField.addEventListener("change", function () {
            materialField.selected = nativeField.checked;
            materialField.checked = nativeField.checked;
        });
        wrapper.appendChild(materialField);
        hideNativeField(nativeField);
        wrapper.classList.add("i2g-md-field--enhanced", "i2g-md-toggle");
    }

    function enhanceRadio(nativeField) {
        var wrapper = ensureWrapper(nativeField);
        var materialField = document.createElement("md-radio");
        materialField.className = "i2g-md-toggle__component";
        materialField.checked = nativeField.checked;
        materialField.disabled = nativeField.disabled;
        materialField.name = nativeField.name + "__material";

        function syncToNative() {
            nativeField.checked = materialField.checked;
            if (nativeField.checked) {
                var root = nativeField.form || document;
                root.querySelectorAll('input[type="radio"][name="' + CSS.escape(nativeField.name) + '"]').forEach(function (radio) {
                    if (radio !== nativeField) radio.checked = false;
                    var wrapper = radio.closest("[data-i2g-md-field]");
                    var materialRadio = wrapper && wrapper.querySelector("md-radio");
                    if (materialRadio && radio !== nativeField) materialRadio.checked = false;
                });
            }
            dispatchNativeEvent(nativeField, "change");
        }

        materialField.addEventListener("change", syncToNative);
        nativeField.addEventListener("change", function () {
            materialField.checked = nativeField.checked;
        });
        wrapper.appendChild(materialField);
        hideNativeField(nativeField);
        wrapper.classList.add("i2g-md-field--enhanced", "i2g-md-toggle");
    }

    function enhanceField(field) {
        if (shouldSkipField(field)) return;

        if (field.tagName === "SELECT") {
            enhanceSelect(field);
        } else if (field.type === "checkbox") {
            enhanceToggle(field);
        } else if (field.type === "radio") {
            enhanceRadio(field);
        } else {
            enhanceTextField(field);
        }
    }

    function enhanceAllFields() {
        document.querySelectorAll("#main input, #main textarea, #main select").forEach(enhanceField);
        document.querySelectorAll("[data-i2g-md-field]").forEach(function (wrapper) {
            var field = wrapper.querySelector("input, textarea, select");
            if (field) enhanceField(field);
        });
    }

    function loadMaterialWeb() {
        Promise.all(modules.map(function (url) { return import(url); }))
            .then(function () {
                return Promise.all([
                    customElements.whenDefined("md-outlined-text-field"),
                    customElements.whenDefined("md-outlined-select"),
                    customElements.whenDefined("md-select-option"),
                    customElements.whenDefined("md-switch"),
                    customElements.whenDefined("md-checkbox"),
                    customElements.whenDefined("md-radio"),
                ]);
            })
            .then(enhanceAllFields)
            .catch(function () {
                // Keep native Django/Unfold controls visible as a safe fallback.
            });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", loadMaterialWeb);
    } else {
        loadMaterialWeb();
    }
})();
