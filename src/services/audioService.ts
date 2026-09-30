import { createAudioPlayer, setAudioModeAsync, AudioPlayer } from 'expo-audio';
import AsyncStorage from '@react-native-async-storage/async-storage';

let playerInstance: AudioPlayer | null = null;
let currentSourceUri: string | null = null;

export const STORAGE_KEYS_AUDIO = {
  CUSTOM_ALARM_URI: '@wake_me_up_custom_alarm_uri',
  CUSTOM_ALARM_NAME: '@wake_me_up_custom_alarm_name',
};

// Nada alarm standar bawaan (sirine digital kencang)
export const DEFAULT_ALARM_URL =
  'https://actions.google.com/sounds/v1/alarms/digital_watch_alarm_long.ogg';

/**
 * Memutar suara alarm secara berulang (looping) di background dan silent mode.
 * Jika pengguna memilih lagu sendiri, lagu tersebut yang akan diputar.
 */
export async function playContinuousAlarm(customUri?: string | null): Promise<void> {
  try {
    let audioToPlay = customUri;

    // Jika customUri tidak diberikan langsung, cek apakah tersimpan di AsyncStorage
    if (!audioToPlay) {
      audioToPlay = await AsyncStorage.getItem(STORAGE_KEYS_AUDIO.CUSTOM_ALARM_URI);
    }

    const targetSource = audioToPlay || DEFAULT_ALARM_URL;

    // Jika sedang memutar lagu yang sama, biarkan terus berjalan
    if (playerInstance && playerInstance.playing && currentSourceUri === targetSource) {
      return;
    }

    // Hentikan player lama jika ada
    if (playerInstance) {
      playerInstance.pause();
    }

    // Konfigurasi audio system: tetap berbunyi saat layar mati dan abaikan mode silent
    await setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: true,
    });

    try {
      playerInstance = createAudioPlayer(targetSource);
      currentSourceUri = targetSource;
      playerInstance.loop = true;
      playerInstance.volume = 1.0;
      playerInstance.play();
    } catch (err) {
      console.warn('[AudioService] Gagal memutar custom audio, beralih ke alarm default:', err);
      // Fallback ke alarm bawaan jika file custom bermasalah
      playerInstance = createAudioPlayer(DEFAULT_ALARM_URL);
      currentSourceUri = DEFAULT_ALARM_URL;
      playerInstance.loop = true;
      playerInstance.volume = 1.0;
      playerInstance.play();
    }
  } catch (error) {
    console.error('[AudioService] Error saat memutar alarm:', error);
  }
}

/**
 * Menghentikan bunyi alarm
 */
export async function stopContinuousAlarm(): Promise<void> {
  try {
    if (playerInstance) {
      playerInstance.pause();
      playerInstance.seekTo(0);
      currentSourceUri = null;
    }
  } catch (error) {
    console.error('[AudioService] Error saat menghentikan alarm:', error);
  }
}

/**
 * Mengecek apakah audio alarm sedang berbunyi
 */
export async function isAlarmSoundPlaying(): Promise<boolean> {
  return playerInstance ? playerInstance.playing : false;
}
