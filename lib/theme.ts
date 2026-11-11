export type ThemeMode = 'light' | 'dark';
export const oliveGreen = '#636b2f';

const common = {
  brand: oliveGreen,
  brandHover: '#535a27',
  onBrand: '#ffffff',
  camera: '#000000',
  cameraCaption: '#000000e6',
  cameraMuted: '#ffffff',
};
export const themePalettes = {
  light: {
    ...common,
    ink: '#1b2733', inkSecondary: '#44525f', muted: '#566473',
    surface: '#ffffff', surfaceSecondary: '#edf0f4', canvas: '#f3f5f8',
    border: '#d5dce4', borderStrong: '#8a98a8',
    chrome: '#ffffff', onChrome: '#1b2733', chromeMuted: '#566473', chromeHover: '#edf0f4',
    brandLight: '#f0f1e5', brandText: oliveGreen,
    green: '#266b43', greenLight: '#e3f1e8', red: '#a52019', redLight: '#fbe6e4',
  },
  dark: {
    ...common,
    ink: '#ffffff', inkSecondary: '#dedede', muted: '#b3b3b3',
    surface: '#111111', surfaceSecondary: '#1c1c1c', canvas: '#000000',
    border: '#707070', borderStrong: '#999999',
    chrome: '#111111', onChrome: '#ffffff', chromeMuted: '#b3b3b3', chromeHover: '#1c1c1c',
    brandLight: '#282c1c', brandText: '#bfc98a',
    green: '#f5f5f5', greenLight: '#222222', red: '#ffffff', redLight: '#303030',
  },
} satisfies Record<ThemeMode, Record<string, string>>;
export type ThemePalette = { [K in keyof typeof themePalettes.light]: string };
