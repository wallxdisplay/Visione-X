export const PRODUCT_NAME = 'WallX Play';
export const PRODUCT_FULL_NAME = 'WallX Play';

/** All server resources (Firestore, Functions, Cloud Run, Storage) live here. */
export const REGION = 'asia-south1';

/** v1 bills in INR only; the money model stores currency so others can be added later. */
export const SUPPORTED_CURRENCIES = ['INR'] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

export const SUPPORTED_UI_LOCALES = ['en'] as const;
/** Planned UI locales; enabled once translations are complete. */
export const PLANNED_UI_LOCALES = ['hi', 'mr'] as const;
export type UiLocale = (typeof SUPPORTED_UI_LOCALES)[number];

export const DEFAULT_TIMEZONE = 'Asia/Kolkata';
