declare const useEffect: (callback: () => void) => void;
declare const fork: (effect: unknown) => void;

useEffect(() => {
  fork(undefined);
});
