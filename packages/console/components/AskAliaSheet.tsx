import { AliaChatSheet, type AliaChatSheetRef } from '@alia.onl/sdk/text';
import { useEffect, useRef } from 'react';

interface AskAliaSheetProps {
  /** Bumped on every press of Ask Alia; each change presents the sheet. */
  askId: number;
  clientContext: string;
  welcomeSuggestions: { id: string; text: string }[];
}

/**
 * Alia's chat sheet, in its own module so `AskAliaProvider` can load the SDK lazily instead of
 * shipping it in the entry bundle. It mounts on the first press, so the first `present()` runs as
 * soon as the sheet is ready. Text only: the sheet comes from `@alia.onl/sdk/text`, the entry that
 * never reaches the voice call's modules, so the call's code is not in the sheet's chunk either.
 * `voice={false}` states the same thing on the sheet itself.
 * The SDK greets and loads the 3D avatar from alia.onl itself.
 */
export default function AskAliaSheet({
  askId,
  clientContext,
  welcomeSuggestions,
}: AskAliaSheetProps) {
  const ref = useRef<AliaChatSheetRef>(null);

  useEffect(() => {
    if (askId > 0) ref.current?.present();
  }, [askId]);

  return (
    <AliaChatSheet
      ref={ref}
      clientContext={clientContext}
      welcomeSuggestions={welcomeSuggestions}
      voice={false}
    />
  );
}
