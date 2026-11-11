export {
  BAYER_2,
  BAYER_4,
  BAYER_8,
  BLUE_NOISE_64,
  DITHER_MATRICES,
  getThresholdMap,
  isInked,
  thresholdAt,
} from "@workspace/ui/lib/dither/matrices";
export type { DitherMatrix, ThresholdMap } from "@workspace/ui/lib/dither/matrices";

export {
  cssColor,
  DEFAULT_PALETTE,
  DITHER_COLOR_NAMES,
  DITHER_COLORS,
  MOTION,
} from "@workspace/ui/lib/dither/tokens";
export type {
  DitherColor,
  DitherColorName,
  DitherPalette,
  Rgba,
} from "@workspace/ui/lib/dither/tokens";

export {
  BLOOM_LEVELS,
  BLOOMS,
  bloomFilter,
  bloomLayerStyle,
  bloomStyle,
  ditherRamp,
  FILL_VARIANTS,
  fillStyle,
  fillTile,
  SERIES_COLORS,
  seriesColor,
} from "@workspace/ui/lib/dither/style";
export type {
  Bloom,
  FillEdge,
  FillStyleOptions,
  FillTile,
  FillVariant,
  RampOptions,
  RampTile,
} from "@workspace/ui/lib/dither/style";

export {
  readDitherCell,
  resolveColor,
  subscribeToTheme,
  useDitherColors,
} from "@workspace/ui/lib/dither/color";

export {
  useDocumentVisible,
  useFrameLoop,
  useInView,
  usePrefersReducedMotion,
} from "@workspace/ui/lib/dither/motion";
export type {
  FrameLoopCallback,
  FrameLoopOptions,
  FrameLoopState,
} from "@workspace/ui/lib/dither/motion";

export { DitherShader, MAX_LIVE_CONTEXTS } from "@workspace/ui/lib/dither/shader";
export type {
  DitherShaderProps,
  DitherShaderState,
  DitherUniforms,
  ShaderUniformValue,
} from "@workspace/ui/lib/dither/shader";

export { BloomBox, BloomGroup, FillPattern } from "@workspace/ui/lib/dither/fill";
export type {
  BloomBoxProps,
  BloomGroupProps,
  FillPatternProps,
  FillRamp,
} from "@workspace/ui/lib/dither/fill";

export {
  DitherPattern,
  ditherMask,
  ditherMaskStyle,
  ditherPath,
} from "@workspace/ui/lib/dither/pattern";
export type {
  DitherMaskOptions,
  DitherMaskStyleOptions,
  DitherPatternProps,
} from "@workspace/ui/lib/dither/pattern";

export { DITHER_METHODS, ditherImage } from "@workspace/ui/lib/dither/diffuse";
export type {
  DiffuseOptions,
  DiffusionMethod,
  DiffusionOptions,
  DitherMethod,
  ImagePalette,
  OrderedMethod,
  OrderedOptions,
  PaletteColor,
  PixelBuffer,
} from "@workspace/ui/lib/dither/diffuse";
