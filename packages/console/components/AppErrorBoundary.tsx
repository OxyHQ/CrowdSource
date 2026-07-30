import React, { Component, type ErrorInfo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, Text, View } from 'react-native';

interface AppErrorBoundaryProps {
  children: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface AppErrorBoundaryState {
  hasError: boolean;
}

/**
 * The fallback deliberately renders no case material and no error detail: a
 * crash in a review screen must not leak the content under review onto a screen
 * anyone can photograph.
 */
function ErrorFallback({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();

  return (
    <View className="flex-1 items-center justify-center gap-4 bg-background p-6">
      <Text className="text-xl font-bold text-foreground">{t('error.boundary.title')}</Text>
      <Text className="max-w-[320px] text-center text-base text-muted-foreground">
        {t('error.boundary.message')}
      </Text>
      <Pressable
        accessibilityRole="button"
        className="rounded-full bg-primary px-6 py-3"
        onPress={onRetry}
      >
        <Text className="text-base font-semibold text-primary-foreground">
          {t('error.boundary.retry')}
        </Text>
      </Pressable>
    </View>
  );
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  static displayName = 'AppErrorBoundary';

  state: AppErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.props.onError?.(error, errorInfo);
  }

  private handleRetry = (): void => {
    this.setState({ hasError: false });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return <ErrorFallback onRetry={this.handleRetry} />;
    }

    return this.props.children;
  }
}
