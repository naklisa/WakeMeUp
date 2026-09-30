import { createAudioPlayer, setAudioModeAsync, AudioPlayer } from 'expo-audio';

let playerInstance: AudioPlayer | null = null;

// Reliable high-frequency wake-up alarm tone
const ALARM_SOUND_URL =
  'https://actions.google.com/sounds/v1/alarms/digital_watch_alarm_long.ogg';

/**
 * Initializes and loops the alarm audio using modern expo-audio (SDK 57)
 */
export async function playContinuousAlarm(): Promise<void> {
  try {
    if (playerInstance && playerInstance.playing) {
      return;
    }

    // Configure system audio mode: allow background playback & ignore silent switch
    await setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: true,
    });

    if (!playerInstance) {
      playerInstance = createAudioPlayer(ALARM_SOUND_URL);
      playerInstance.loop = true;
      playerInstance.volume = 1.0;
    }

    playerInstance.play();
  } catch (error) {
    console.error('[AudioService] Failed to play continuous alarm:', error);
  }
}

/**
 * Stops and silences the continuous alarm audio
 */
export async function stopContinuousAlarm(): Promise<void> {
  try {
    if (playerInstance) {
      playerInstance.pause();
      playerInstance.seekTo(0);
    }
  } catch (error) {
    console.error('[AudioService] Failed to stop alarm sound:', error);
  }
}

/**
 * Returns whether the alarm audio is currently playing
 */
export async function isAlarmSoundPlaying(): Promise<boolean> {
  return playerInstance ? playerInstance.playing : false;
}
