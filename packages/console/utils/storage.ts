import AsyncStorage from '@react-native-async-storage/async-storage';

import { logger } from '@/lib/logger';

/**
 * JSON-serializing wrapper over AsyncStorage for local preferences.
 *
 * Never store case material, evidence or assignment tokens here: this is
 * unencrypted device storage. Anything the server issues belongs to the SDK's
 * secure session storage.
 */
export class Storage {
  static async get<T>(key: string): Promise<T | null> {
    try {
      const item = await AsyncStorage.getItem(key);
      return item ? (JSON.parse(item) as T) : null;
    } catch (error) {
      logger.warn(`[Storage] Failed to get item: ${key}`, { error });
      return null;
    }
  }

  static async set<T>(key: string, value: T): Promise<boolean> {
    try {
      await AsyncStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      logger.warn(`[Storage] Failed to set item: ${key}`, { error });
      return false;
    }
  }

  static async remove(key: string): Promise<boolean> {
    try {
      await AsyncStorage.removeItem(key);
      return true;
    } catch (error) {
      logger.warn(`[Storage] Failed to remove item: ${key}`, { error });
      return false;
    }
  }
}
