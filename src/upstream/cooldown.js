/** Short failure cooldown layered under the normal successful-result cache. */
import { getOrLoad } from "../cache.js";
export async function withProviderCooldown(key, loader) {
  const attempt = await getOrLoad(`attempt:${key}`, 60_000, async () => {
    try { return { value: await loader() }; } catch (error) { return { error }; }
  });
  if (attempt.error) throw attempt.error;
  return attempt.value;
}
