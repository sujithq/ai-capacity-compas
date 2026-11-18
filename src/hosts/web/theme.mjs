export const THEME_STORAGE_KEY = "ai-capacity-compass.theme";
const THEMES = new Set(["light", "dark"]);
const NO_MEDIA = { matches: false, addEventListener() {}, removeEventListener() {} };
const NO_WINDOW = { addEventListener() {}, removeEventListener() {} };

export class WebTheme {
    constructor(
        storage = globalThis.localStorage,
        media = globalThis.matchMedia?.("(prefers-color-scheme: dark)") ?? NO_MEDIA,
        windowObject = globalThis.window ?? NO_WINDOW,
    ) {
        this.storage = storage;
        this.media = media;
        this.window = windowObject;
    }

    getTheme() {
        const preference = this.storage.getItem(THEME_STORAGE_KEY);
        if (THEMES.has(preference)) return preference;
        return this.media.matches ? "dark" : "light";
    }

    setTheme(theme) {
        if (!THEMES.has(theme)) throw new Error(`Unsupported theme: ${theme}`);
        this.storage.setItem(THEME_STORAGE_KEY, theme);
    }

    subscribe(listener) {
        const update = () => {
            if (!THEMES.has(this.storage.getItem(THEME_STORAGE_KEY))) listener(this.getTheme());
        };
        this.media.addEventListener("change", update);
        const onStorage = (event) => {
            if (event.key === THEME_STORAGE_KEY) listener(this.getTheme());
        };
        this.window.addEventListener("storage", onStorage);
        return () => {
            this.media.removeEventListener("change", update);
            this.window.removeEventListener("storage", onStorage);
        };
    }
}
