/**
 * CrowdSource's mark: three figures holding a shared loop — the same glyph the
 * launcher icon carries, drawn here as vector so the app can render it at any
 * size and in any theme.
 *
 * Deliberately NOT the launcher bitmap. That artwork is a white glyph locked to
 * a brand-teal disc, which is correct on a home screen and wrong inside the app:
 * a fixed dark disc would sit unchanged on a light surface. So the disc is
 * dropped and only the figure survives, taking its colour from the Bloom theme
 * the way every Bloom icon does — `theme.colors.primary` resolves per mode, so
 * the mark stays legible in light and in dark.
 *
 * The prop surface mirrors `LogoIcon`/`LogoText` in `@oxyhq/services` on
 * purpose: `color` for the explicit override a splash or an inverted surface
 * needs, `height` in pixels with the width derived from the viewBox. Anything
 * rendering an Oxy-ecosystem mark should look the same from the call site.
 */

import { useTheme } from '@oxyhq/bloom/theme';
import type React from 'react';
import type { ReactElement } from 'react';
import type { ViewStyle } from 'react-native';
import Svg, { Path } from 'react-native-svg';

interface LogoIconProps {
  /**
   * Colour of the mark. Defaults to the resolved Bloom theme primary. Pass an
   * explicit colour only where the Bloom theme is not mounted, or where the
   * surface underneath is not one the theme knows about.
   */
  color?: string;
  /** Height in pixels. Width is derived from the SVG viewBox aspect ratio. */
  height?: number;
  /** Style passed through to the root SVG element. */
  style?: ViewStyle;
}

/**
 * Material Symbols geometry: the box is 960 wide and 960 tall but starts at
 * y = -960, so the glyph is drawn in negative-y space. Keeping the authored
 * viewBox means the path below is the source artwork byte for byte.
 */
const VIEW_BOX_WIDTH = 960;
const VIEW_BOX_HEIGHT = 960;
const VIEW_BOX = `0 -960 ${VIEW_BOX_WIDTH} ${VIEW_BOX_HEIGHT}`;
const DEFAULT_HEIGHT = 32;

const MARK_PATH =
  'M350.5-65.5q-46.5 0-83.5-25.25T211.5-158q-15.5 22-40.25 34.25T120-111.5q-49.5 0-83.75-34.25T2-229q0-43.5 29-77.5t73-37.5q-15-20-23.25-43.5t-8.25-49q0-41 22-76.5t61.5-56.5q4.5 17 13 35.75t18 33.25q-18.5 11-28.5 28.25t-10 36.75q0 57 46.5 71t88.5 22l17 29Q289-281 281.25-258.75t-7.75 40.25q0 31 22.5 54.5t54 23.5q38.5 0 64-34t41.75-80.25Q472-301 480.5-348.25t14-73.25l73 20q-9 44-21.75 101.75t-36 110q-23.25 52.25-61 88.25t-98.25 36ZM120-186.5q18 0 30.25-12.25T162.5-229q0-18-12.25-30.25T120-271.5q-18 0-30.25 12.25T77.5-229q0 18 12.25 30.25T120-186.5ZM405.5-349q-45.5-41-82.75-76.25t-64.25-68.5Q231.5-527 217-560t-14.5-69q0-64 43.75-107.75T354-780.5q5 0 9.25.25t8.75.75q-5-10.5-7.25-21T362.5-823q0-49 34.25-83.25T480-940.5q49 0 83.25 34.25T597.5-823q0 12-2.5 22.25T587.5-780q4.5-.5 9-.5h9.5q60.5 0 102.5 40t47.5 99q-17-2.5-37.75-2.75T680-642.5q-5.5-27-25.25-45t-48.75-18q-35 0-55.25 20.5T496-624.5h-33q-35.5-41.5-55.5-61.25T354-705.5q-33 0-54.75 21.75T277.5-629q0 23.5 13 48t36.75 52.25q23.75 27.75 57.25 59t75 67.75l-54 53Zm104.75-443.75Q522.5-805 522.5-823t-12.25-30.25Q498-865.5 480-865.5t-30.25 12.25Q437.5-841 437.5-823t12.25 30.25Q462-780.5 480-780.5t30.25-12.25ZM608.5-65.5q-23.5 0-46.25-7.25T518.5-95.5q10-14 20.5-31.75t18-33.25q12.5 10.5 25.75 15.25t26.75 4.75q32.5 0 55.25-23.5t22.75-55q0-19-8-41.25t-19-54.25l16.5-29q43.5-8 89.5-21.75t46-71.25q0-41-30-59.5t-66-18.5q-42 0-98.75 16T486-457.5l-19-73q77.5-25 138.25-42t111.75-17q67.5 0 119 40.25T887.5-436q0 25.5-8 48.75t-23 43.25q44 3.5 72.75 37.5T958-229q0 49-34.25 83.25T840-111.5q-26.5 0-51.25-12.25T748.5-158q-19.5 42.5-56 67.5t-84 25Zm262.25-133.25Q882.5-211 882.5-229t-12.25-30.75Q858-272.5 840-272.5t-30.25 12.25Q797.5-248 797.5-230t12.75 30.75Q823-186.5 841-186.5t29.75-12.25ZM120-229Zm360-594Zm360 593Z';

export const LogoIcon: React.FC<LogoIconProps> = ({
  color,
  height: heightProp,
  style,
}): ReactElement => {
  const height = heightProp ?? DEFAULT_HEIGHT;
  const width = height * (VIEW_BOX_WIDTH / VIEW_BOX_HEIGHT);

  // react-native-svg has no CSS cascade, so the glyph cannot inherit a colour
  // from a `className` on an ancestor: the fill has to be a resolved value.
  const { colors } = useTheme();

  return (
    <Svg width={width} height={height} viewBox={VIEW_BOX} style={style}>
      <Path d={MARK_PATH} fill={color ?? colors.primary} />
    </Svg>
  );
};

export default LogoIcon;
