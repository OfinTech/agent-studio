export const settingKeys = [
  "TOOL_ALLOWED_ORIGINS",
  "MAX_ATTACHMENT_BYTES",
  "RESEND_API_KEY",
  "RESEND_WEBHOOK_SECRET",
] as const;
export type SettingKey = (typeof settingKeys)[number];
const secretKeys: SettingKey[] = ["RESEND_API_KEY", "RESEND_WEBHOOK_SECRET"];
export const settings = new Map<SettingKey, string>();
export const setting = (key: SettingKey) => settings.get(key) ?? "";
export async function loadSettings() {
  const { query, decrypt } = await import("./index");
  const rows = await query<{ key: SettingKey; value: string }>(
    "SELECT key,value FROM settings",
  );
  settings.clear();
  for (const row of rows)
    settings.set(
      row.key,
      secretKeys.includes(row.key) ? decrypt(row.value, row.key) : row.value,
    );
}
export async function saveSetting(key: SettingKey, value: string) {
  const { query, encrypt } = await import("./index");
  if (value) {
    await query(
      "INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",
      [key, secretKeys.includes(key) ? encrypt(value, key) : value],
    );
    settings.set(key, value);
  } else {
    await query("DELETE FROM settings WHERE key=$1", [key]);
    settings.delete(key);
  }
}
