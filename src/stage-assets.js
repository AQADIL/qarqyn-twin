const illustratedStages = new Set([
  'warehouse',
  'welding',
  'painting',
  'assembly',
  'quality',
  'finished'
]);

const prefix = (theme) => (theme === 'dark' ? 'cosmic' : 'stage');
export const stageImage = (id, theme = 'light') =>
  illustratedStages.has(id) ? `/${prefix(theme)}-${id}-384.webp` : '/stage-generic.svg';
export const stageImageSources = (id, theme = 'light') =>
  illustratedStages.has(id)
    ? `/${prefix(theme)}-${id}-384.webp 384w, /${prefix(theme)}-${id}-768.webp 768w`
    : undefined;
export const stageIcon = (id) => (illustratedStages.has(id) ? id : 'overview');
