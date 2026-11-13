declare const useEffect: (callback: () => void) => void;
declare const AsyncResult: { isSuccess: (result: unknown) => boolean };

useEffect(() => {
  if (AsyncResult.isSuccess(undefined)) {
    document.title = "Saved";
  }
});
