import { Slot } from 'expo-router';
import { View } from 'react-native';

import { AppNav } from '@/components/AppNav';

export default function AppLayout() {
  return (
    <View className="flex-1 bg-background">
      <AppNav />
      <Slot />
    </View>
  );
}
