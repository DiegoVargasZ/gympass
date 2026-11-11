export type ThemeMode = 'light' | 'dark';
export const neonGreen = '#b6ff00';

const common = {
  brand: neonGreen,
  brandHover: '#a3e600',
  onBrand: '#000000',
  camera: '#000000',
  cameraCaption: '#000000e6',
  cameraMuted: '#ffffff',
};
export const themePalettes = {
  light: {
    ...common,
    ink: '#000000', inkSecondary: '#333333', muted: '#555555',
    surface: '#ffffff', surfaceSecondary: '#f2f2f2', canvas: '#ffffff',
    border: '#d4d4d4', borderStrong: '#767676',
    chrome: '#000000', onChrome: '#ffffff', chromeMuted: '#d4d4d4', chromeHover: '#242424',
    brandLight: '#efffd1', brandText: '#365c00',
    green: '#365c00', greenLight: '#efffd1', red: '#a52019', redLight: '#fbe6e4',
  },
  dark: {
    ...common,
    ink: '#ffffff', inkSecondary: '#e5e5e5', muted: '#bdbdbd',
    surface: '#101010', surfaceSecondary: '#1c1c1c', canvas: '#000000',
    border: '#454545', borderStrong: '#8a8a8a',
    chrome: '#ffffff', onChrome: '#000000', chromeMuted: '#333333', chromeHover: '#e5e5e5',
    brandLight: '#1c2d00', brandText: neonGreen,
    green: neonGreen, greenLight: '#1c2d00', red: '#ffb4ab', redLight: '#381714',
  },
} satisfies Record<ThemeMode, Record<string, string>>;
export type ThemePalette = { [K in keyof typeof themePalettes.light]: string };
