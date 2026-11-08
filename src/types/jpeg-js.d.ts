declare module "jpeg-js" {
  interface DecodedImage {
    data: Uint8Array;
    width: number;
    height: number;
  }
  interface EncodedImage {
    data: Uint8Array;
    width: number;
    height: number;
  }
  const jpeg: {
    decode(data: Buffer | Uint8Array, options?: { useTArray?: boolean }): DecodedImage;
    encode(image: { data: Uint8Array; width: number; height: number }, quality?: number): EncodedImage;
  };
  export = jpeg;
}
