(function () {
    "use strict";

    var STORAGE_KEY = "i2g_admin_sidebar_scroll_top";
    var RESTORE_ATTEMPTS = 20;

    function getScrollEl() {
        return (
            document.querySelector("#nav-sidebar-apps .simplebar-content-wrapper") ||
            document.querySelector("#nav-sidebar .simplebar-content-wrapper") ||
            document.querySelector("#nav-sidebar-apps") ||
            document.querySelector("#nav-sidebar-inner")
        );
    }

    function saveScroll() {
        try {
            var element = getScrollEl();
            if (!element) return;
            sessionStorage.setItem(STORAGE_KEY, String(element.scrollTop || 0));
        } catch (_error) {
            // Storage can be unavailable in hardened/private browser modes.
        }
    }

    function restoreScroll() {
        try {
            var element = getScrollEl();
            if (!element) return;
            var raw = sessionStorage.getItem(STORAGE_KEY);
            if (raw == null) return;
            var value = parseInt(raw, 10);
            if (Number.isNaN(value)) return;
            element.scrollTop = value;
        } catch (_error) {
            // Storage can be unavailable in hardened/private browser modes.
        }
    }

    function restoreScrollWhenReady(attempt) {
        restoreScroll();
        if (attempt >= RESTORE_ATTEMPTS) return;

        var element = getScrollEl();
        var raw = sessionStorage.getItem(STORAGE_KEY);
        var value = raw == null ? null : parseInt(raw, 10);
        if (
            !element ||
            value == null ||
            Number.isNaN(value) ||
            Math.abs((element.scrollTop || 0) - value) < 2
        ) {
            return;
        }
        window.requestAnimationFrame(function () {
            restoreScrollWhenReady(attempt + 1);
        });
    }

    window.addEventListener("pagehide", saveScroll);
    window.addEventListener("beforeunload", saveScroll);
    document.addEventListener("click", function (event) {
        var target = event.target;
        if (!target || !target.closest) return;
        var link = target.closest("a");
        if (link && link.closest("#nav-sidebar")) saveScroll();
    });
    document.addEventListener("DOMContentLoaded", function () {
        window.setTimeout(function () {
            restoreScrollWhenReady(0);
        }, 0);
    });
})();
