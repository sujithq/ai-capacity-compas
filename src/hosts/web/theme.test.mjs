import { test } from "node:test";
import assert from "node:assert/strict";
import { STYLE_STORAGE_KEY, THEME_STORAGE_KEY, WebStyle, WebTheme } from "./theme.mjs";

class MemoryStorage {
    values = new Map();
    getItem(key) { return this.values.get(key) ?? null; }
    setItem(key, value) { this.values.set(key, String(value)); }
}

class EventTargetMock {
    listeners = new Map();
    addEventListener(type, listener) {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
    }
    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
    emit(type, event) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
}

class MediaMock extends EventTargetMock {
    constructor(matches) { super(); this.matches = matches; }
    setMatches(matches) {
        this.matches = matches;
        this.emit("change", { matches });
    }
}

test("theme defaults to the system preference until the user chooses a theme", () => {
    const storage = new MemoryStorage();
    const media = new MediaMock(true);
    const theme = new WebTheme(storage, media, new EventTargetMock());
    assert.equal(theme.getTheme(), "dark");
    theme.setTheme("light");
    assert.equal(storage.getItem(THEME_STORAGE_KEY), "light");
    assert.equal(theme.getTheme(), "light");
    assert.throws(() => theme.setTheme("system"), /Unsupported theme/);
});

test("theme preference persists and system changes apply only before explicit choice", () => {
    const storage = new MemoryStorage();
    const media = new MediaMock(false);
    const windowObject = new EventTargetMock();
    const theme = new WebTheme(storage, media, windowObject);
    const updates = [];
    const unsubscribe = theme.subscribe((value) => updates.push(value));

    media.setMatches(true);
    assert.deepEqual(updates, ["dark"]);
    theme.setTheme("light");
    media.setMatches(false);
    assert.deepEqual(updates, ["dark"]);
    assert.equal(new WebTheme(storage, media, windowObject).getTheme(), "light");

    storage.setItem(THEME_STORAGE_KEY, "dark");
    windowObject.emit("storage", { key: THEME_STORAGE_KEY });
    assert.deepEqual(updates, ["dark", "dark"]);
    unsubscribe();
    assert.equal(media.listeners.get("change").size, 0);
    assert.equal(windowObject.listeners.get("storage").size, 0);
});

test("style defaults to Classic, persists independently, and syncs across tabs", () => {
    const storage = new MemoryStorage();
    const windowObject = new EventTargetMock();
    const style = new WebStyle(storage, windowObject);
    const updates = [];
    const unsubscribe = style.subscribe((value) => updates.push(value));

    assert.equal(style.getStyle(), "classic");
    style.setStyle("fluent");
    assert.equal(storage.getItem(STYLE_STORAGE_KEY), "fluent");
    assert.equal(new WebStyle(storage, windowObject).getStyle(), "fluent");
    assert.equal(new WebTheme(storage, new MediaMock(false), windowObject).getTheme(), "light");
    windowObject.emit("storage", { key: STYLE_STORAGE_KEY });
    assert.deepEqual(updates, ["fluent"]);
    assert.throws(() => style.setStyle("modern"), /Unsupported style/);
    unsubscribe();
    assert.equal(windowObject.listeners.get("storage").size, 0);
});
