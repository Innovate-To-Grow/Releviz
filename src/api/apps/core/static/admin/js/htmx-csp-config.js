(function () {
    "use strict";

    if (!window.htmx || !window.htmx.config) return;

    // HTMX includes opt-in expression/script execution paths that rely on
    // eval. The admin uses neither feature, so fail closed before HTMX's
    // DOMContentLoaded initialization runs.
    window.htmx.config.allowEval = false;
    window.htmx.config.allowScriptTags = false;

    // Unfold already bundles the indicator styles. Prevent HTMX from adding
    // an extra inline <style> element that would be rejected by enforcing CSP.
    window.htmx.config.includeIndicatorStyles = false;
})();
