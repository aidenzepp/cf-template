declare const AsyncResult: { isSuccess: (result: unknown) => boolean };

export const saved = AsyncResult.isSuccess(undefined);
