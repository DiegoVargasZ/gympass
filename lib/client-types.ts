/** Public response types shared with local clients, without importing local server implementations. */
export type CameraLinkReport = {
  state: 'disabled' | 'starting' | 'ready' | 'error';
  url: string | null;
  detail: string;
};
export type ActivationStatus = {
  machineId: string;
  state: 'trial' | 'active' | 'expired';
  days: number;
  trialEndsAt: number;
  activatedAt: number | null;
  licenseType: 'trial' | 'monthly' | 'permanent';
  months: number | null;
  expiresAt: number | null;
};
