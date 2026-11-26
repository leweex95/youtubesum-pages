(() => {
  "use strict";

  const themes = {
    night: "#111519",
    sage: "#f1f5f0",
    paper: "#f7f7f4",
  };
  const root = document.documentElement;
  const picker = document.getElementById("theme-select");
  let preferredTheme = root.dataset.theme;

  try {
    const savedTheme = localStorage.getItem("ys-theme");
    if (Object.hasOwn(themes, savedTheme)) preferredTheme = savedTheme;
  } catch {
    // Theme selection still works for the current page when storage is blocked.
  }

  function applyTheme(theme, persist = false) {
    if (!Object.hasOwn(themes, theme)) theme = "night";
    root.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", themes[theme]);
    if (picker) picker.value = theme;
    if (persist) {
      try {
        localStorage.setItem("ys-theme", theme);
      } catch {
        // A blocked storage API does not prevent changing the current page.
      }
    }
  }

  applyTheme(preferredTheme);
  picker?.addEventListener("change", () => applyTheme(picker.value, true));
})();
