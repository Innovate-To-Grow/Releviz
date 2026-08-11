(function () {
    "use strict";

    // Same-origin srcdoc previews inherit the parent policy. Their generated
    // style elements must therefore carry this response's nonce as well.
    window.I2G_CSP_NONCE = (document.currentScript && document.currentScript.nonce) || "";
    // Lit/Material Web copies this value to fallback <style> elements on
    // browsers without constructable stylesheet support.
    window.litNonce = window.I2G_CSP_NONCE;

    // Source-owned admin editors use declarative action attributes instead of
    // executable on* attributes. Keep this allowlist explicit: data from a
    // rendered record must never select an arbitrary global function.
    var ALLOWED_CALLS = new Set([
        "addBlock",
        "addChildItem",
        "addColumn",
        "addColumnLink",
        "addCtaButton",
        "addFooterLink",
        "addMenuItem",
        "addRepeaterItem",
        "addSocialLink",
        "applyJson",
        "applyJsonChanges",
        "changeCtaType",
        "changeFooterLinkType",
        "changeItemType",
        "copyJson",
        "moveBlock",
        "moveItem",
        "moveRepeaterItem",
        "openLivePreview",
        "refreshInlinePreview",
        "removeBlock",
        "removeColumn",
        "removeColumnLink",
        "removeCtaButton",
        "removeFooterLink",
        "removeItem",
        "removeRepeaterItem",
        "removeSocialLink",
        "selectAppRoute",
        "selectCtaAppRoute",
        "selectCtaCmsRoute",
        "selectFooterLinkAppRoute",
        "selectFooterLinkCmsRoute",
        "setPreviewDevice",
        "toggleBlockPreview",
        "toggleCollapse",
        "toggleInlinePreview",
        "toggleJsonView",
        "updateBlockData",
        "updateBlockDataDirect",
        "updateBlockDataJson",
        "updateBlockProp",
        "updateColumn",
        "updateColumnLink",
        "updateCtaButton",
        "updateEmbedWidgetHiddenSection",
        "updateEmbedWidgetSlug",
        "updateFooterLink",
        "updateItem",
        "updateSocialPlatform",
        "updateSocialLink",
    ]);

    function closestElement(target, selector) {
        if (!target) return null;
        var element = target.nodeType === 1 ? target : target.parentElement;
        return element && element.closest ? element.closest(selector) : null;
    }

    function parsedArgs(element) {
        try {
            var value = JSON.parse(element.dataset.adminArgs || "[]");
            return Array.isArray(value) ? value : [];
        } catch (_error) {
            return [];
        }
    }

    function dispatchCall(event) {
        var element = closestElement(event.target, "[data-admin-call]");
        if (!element || element.dataset.adminEvent !== event.type) return;

        var name = element.dataset.adminCall || "";
        if (!ALLOWED_CALLS.has(name) || typeof window[name] !== "function") return;

        var args = parsedArgs(element);
        if (element.dataset.adminValue === "value") {
            args.push(element.value);
        } else if (element.dataset.adminValue === "checked") {
            args.push(Boolean(element.checked));
        } else if (element.dataset.adminValue === "selected-text") {
            var selected = element.options && element.options[element.selectedIndex];
            args.push(element.value, selected ? selected.text : "");
        } else if (element.dataset.adminValue === "element") {
            args.push(element);
        }
        event.preventDefault();
        window[name].apply(window, args);
    }

    function handleAdminAction(event) {
        var element = closestElement(event.target, "[data-admin-action]");
        if (!element) return;
        if (element.dataset.adminAction === "history-back") {
            event.preventDefault();
            window.history.back();
        } else if (element.dataset.adminAction === "select-content") {
            element.select();
        }
    }

    function confirmAction(event) {
        var element = closestElement(event.target, "[data-admin-confirm]");
        if (!element) return;
        if (!window.confirm(element.dataset.adminConfirm || "Continue?")) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    }

    document.addEventListener("click", confirmAction, true);
    document.addEventListener("click", handleAdminAction);
    document.addEventListener("click", dispatchCall);
    document.addEventListener("input", dispatchCall);
    document.addEventListener("change", dispatchCall);
})();
