import { useState, useEffect } from 'react';

/**
 * Detect the user's timezone from the browser.
 * Returns 'UTC' on the server and during initial hydration,
 * then updates to the detected timezone on the client.
 */
export function useBrowserTimezone(fallback: string = 'UTC'): string {
  const [timezone, setTimezone] = useState(fallback);

  useEffect(() => {
    try {
      const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (detected) {
        setTimezone(detected);
      }
    } catch {
      // Keep fallback
    }
  }, []);

  return timezone;
}
