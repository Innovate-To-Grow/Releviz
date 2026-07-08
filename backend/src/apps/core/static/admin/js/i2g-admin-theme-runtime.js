(function () {
    "use strict";

    var STORAGE_KEY = "adminTheme";
    var VALID_THEMES = {
        auto: true,
        dark: true,
        light: true,
    };

    function normalizeTheme(value) {
        return VALID_THEMES[value] ? value : "auto";
    }

    function prefersDarkColorScheme() {
        return Boolean(
            window.matchMedia &&
                window.matchMedia("(prefers-color-scheme: dark)").matches
        );
    }

    function readStoredTheme(defaultTheme) {
        try {
            var storedTheme = window.localStorage.getItem(STORAGE_KEY);

            if (storedTheme == null) {
                return normalizeTheme(defaultTheme);
            }

            try {
                return normalizeTheme(JSON.parse(storedTheme));
            } catch (error) {
                // Legacy I2G runtime builds wrote raw strings; normalize and migrate them.
                return normalizeTheme(storedTheme);
            }
        } catch (error) {
            return normalizeTheme(defaultTheme);
        }
    }

    function writeStoredTheme(themeName) {
        try {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeTheme(themeName)));
        } catch (error) {
            // Ignore unavailable storage; Alpine still updates the current page.
        }
    }

    function persistedTheme(defaultTheme) {
        var initialTheme = readStoredTheme(defaultTheme || "auto");

        if (window.Alpine && typeof window.Alpine.$persist === "function") {
            return window.Alpine.$persist(initialTheme).as(STORAGE_KEY);
        }

        return initialTheme;
    }

    function setBodyOverflowLocked(isLocked) {
        if (!document.body) return;
        document.body.classList.toggle("overflow-hidden", Boolean(isLocked));
    }

    function resolvedClassName(themeName, systemDark) {
        if (themeName === "dark") {
            return "dark";
        }

        if (themeName === "light") {
            return "light";
        }

        return systemDark ? "dark" : "";
    }

    function applyThemeClass(themeName, systemDark) {
        var className = resolvedClassName(normalizeTheme(themeName), systemDark);

        document.documentElement.classList.toggle("dark", className === "dark");
        document.documentElement.classList.toggle("light", className === "light");
    }

    function dispatchThemeChange(themeName, systemDark) {
        window.dispatchEvent(
            new CustomEvent("i2g-admin-theme-change", {
                detail: {
                    theme: normalizeTheme(themeName),
                    systemDark: Boolean(systemDark),
                },
            })
        );
    }

    function watchBodyLocks(component) {
        var update = function () {
            setBodyOverflowLocked(
                component.openModal ||
                    component.filterOpen ||
                    component.openAllApplications
            );
        };

        if (typeof component.$watch !== "function") {
            update();
            return;
        }

        component.$watch("openModal", update);
        component.$watch("filterOpen", update);
        component.$watch("openAllApplications", update);
        update();
    }

    function installThemeChoiceClickHandler() {
        if (window.__i2gAdminThemeChoiceHandlerInstalled) {
            return;
        }

        window.__i2gAdminThemeChoiceHandlerInstalled = true;
        var handleThemeChoice = function (event) {
            var target = event.target;

            if (!target || typeof target.closest !== "function") {
                return;
            }

            var choice = target.closest("[data-admin-theme-choice]");

            if (!choice) {
                return;
            }

            window.switchTheme(choice.getAttribute("data-admin-theme-choice"));
        };

        document.addEventListener("pointerdown", handleThemeChoice, true);
        document.addEventListener("click", handleThemeChoice, true);
    }

    var initialTheme = readStoredTheme("auto");
    var initialSystemDark = prefersDarkColorScheme();

    window.adminTheme = initialTheme;
    window.switchTheme = function switchTheme(themeName) {
        var nextTheme = normalizeTheme(themeName);
        var systemDark = prefersDarkColorScheme();

        window.adminTheme = nextTheme;
        writeStoredTheme(nextTheme);
        applyThemeClass(nextTheme, systemDark);
        dispatchThemeChange(nextTheme, systemDark);
    };
    window.themeBindings = {
        "x-bind:class": function () {
            return resolvedClassName(this.adminTheme || window.adminTheme, this.systemDark);
        },
        "x-on:keydown.window": function (event) {
            if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "e") {
                return;
            }

            event.preventDefault();
            this.switchTheme(this.adminTheme === "light" ? "dark" : "light");
        },
    };

    window.theme = function theme(defaultTheme) {
        return {
            openModal: false,
            openTheme: false,
            filterOpen: false,
            openAllApplications: false,
            systemDark: prefersDarkColorScheme(),
            adminTheme: persistedTheme(defaultTheme || "auto"),
            init: function () {
                var component = this;
                watchBodyLocks(component);
                window.addEventListener("i2g-admin-theme-change", function (event) {
                    component.adminTheme = normalizeTheme(event.detail && event.detail.theme);
                    component.systemDark = Boolean(event.detail && event.detail.systemDark);
                });

                if (!window.matchMedia) return;

                var media = window.matchMedia("(prefers-color-scheme: dark)");
                var refreshSystemTheme = function () {
                    component.systemDark = prefersDarkColorScheme();
                    applyThemeClass(component.adminTheme, component.systemDark);
                };

                if (typeof media.addEventListener === "function") {
                    media.addEventListener("change", refreshSystemTheme);
                } else if (typeof media.addListener === "function") {
                    media.addListener(refreshSystemTheme);
                }
            },
            switchTheme: function (themeName) {
                var nextTheme = normalizeTheme(themeName);
                this.adminTheme = nextTheme;
                window.switchTheme(nextTheme);
            },
            switchAdminTheme: function (themeName) {
                this.switchTheme(themeName);
                this.openTheme = false;
            },
            themeBindings: window.themeBindings,
        };
    };

    writeStoredTheme(initialTheme);
    applyThemeClass(initialTheme, initialSystemDark);
    installThemeChoiceClickHandler();
})();
