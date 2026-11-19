// Themes the Android long-press menu with the web menu's palette.
// @react-native-menu/menu shows a framework android.widget.PopupMenu
// (android/.../MenuView.kt: `PopupMenu(context, this)`), which takes its
// surface from the activity theme's android:popupMenuStyle and its item text
// from android:textAppearanceLargePopupMenu. AppTheme is DayNight, so the
// light colors (Ivory) go in values/ and the dark ones (Default) in values-night/.
const fs = require("node:fs");
const path = require("node:path");
const { AndroidConfig, withAndroidColors, withAndroidColorsNight, withAndroidStyles, withDangerousMod } = require("expo/config-plugins");

const COLOR = { surface: "lh_menu_surface", border: "lh_menu_border", text: "lh_menu_text" };
const BACKGROUND = "lh_menu_background";

/** The web menu (components/sidebar.tsx): bg-card, a border, rounded-xl. */
const background = `<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">
  <solid android:color="@color/${COLOR.surface}" />
  <stroke android:width="1dp" android:color="@color/${COLOR.border}" />
  <corners android:radius="12dp" />
  <padding android:top="8dp" android:bottom="8dp" />
</shape>
`;

function assignColors(config, palette) {
  for (const [key, name] of Object.entries(COLOR)) {
    config.modResults = AndroidConfig.Colors.assignColorValue(config.modResults, { name, value: palette[key] });
  }
  return config;
}

module.exports = function withAndroidMenuTheme(config, { light, dark }) {
  config = withAndroidColors(config, (mod) => assignColors(mod, light));
  config = withAndroidColorsNight(config, (mod) => assignColors(mod, dark));
  config = withAndroidStyles(config, (mod) => {
    const set = (parent, name, value) => {
      mod.modResults = AndroidConfig.Styles.assignStylesValue(mod.modResults, { add: true, parent, name, value });
    };
    const menu = { name: "LhPopupMenu", parent: "@android:style/Widget.Material.PopupMenu" };
    const text = { name: "LhPopupMenuText", parent: "@android:style/TextAppearance.Material.Widget.PopupMenu.Large" };
    set(menu, "android:popupBackground", `@drawable/${BACKGROUND}`);
    set(text, "android:textColor", `@color/${COLOR.text}`);
    const theme = AndroidConfig.Styles.getAppThemeGroup();
    set(theme, "android:popupMenuStyle", "@style/LhPopupMenu");
    set(theme, "android:textAppearanceLargePopupMenu", "@style/LhPopupMenuText");
    return mod;
  });
  return withDangerousMod(config, ["android", (mod) => {
    const folder = path.join(mod.modRequest.platformProjectRoot, "app/src/main/res/drawable");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, `${BACKGROUND}.xml`), background);
    return mod;
  }]);
};
