// What one person may use on this server. Admin accounts have no limits.
// Anyone else has the limit an admin set for them, or the server's default.

export function storageLimitFor(config, user) {
  if (user.is_admin) return null;
  return user.storage_limit_bytes ?? config.storage.perUserBytes;
}

export function accountLimitFor(config, user) {
  if (user.is_admin) return null;
  return user.account_limit ?? config.accounts.perUser;
}
