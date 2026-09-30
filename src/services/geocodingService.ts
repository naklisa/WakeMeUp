export interface SearchLocationResult {
  placeId: string;
  name: string;
  displayName: string;
  latitude: number;
  longitude: number;
}

/**
 * Mencari lokasi berdasarkan nama tempat menggunakan OpenStreetMap Nominatim API (Gratis tanpa API key)
 */
export async function searchPlacesOSM(query: string): Promise<SearchLocationResult[]> {
  const trimmed = query.trim();
  if (trimmed.length < 3) return [];

  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(
      trimmed
    )}&format=json&addressdetails=1&limit=5`;

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'WakeMeUp-Expo-App/2.0 (contact: mobile-app)',
        'Accept-Language': 'id,en',
      },
    });

    if (!response.ok) {
      console.warn('[GeocodingService] Gagal fetch Nominatim:', response.status);
      return [];
    }

    const data = await response.json();
    if (!Array.isArray(data)) return [];

    return data.map((item: any) => ({
      placeId: String(item.place_id),
      name: item.name || item.display_name.split(',')[0],
      displayName: item.display_name,
      latitude: parseFloat(item.lat),
      longitude: parseFloat(item.lon),
    }));
  } catch (error) {
    console.error('[GeocodingService] Error saat mencari tempat:', error);
    return [];
  }
}
