declare const useEffect: (callback: () => void) => void;
declare const run: (effect: unknown) => void;

useEffect(() => {
  run(undefined);
});
