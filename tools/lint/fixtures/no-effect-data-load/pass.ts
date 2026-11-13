declare const useEffect: (callback: () => void) => void;
declare const run: (effect: unknown) => void;

useEffect(() => {
  document.title = "Notes";
});

export const load = () => {
  run(undefined);
};
