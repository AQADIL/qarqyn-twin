const illustratedStages = new Set(['warehouse', 'welding', 'painting', 'assembly', 'quality', 'finished']);

export const stageImage = (id) => illustratedStages.has(id) ? `/stage-${id}.png` : '/stage-generic.svg';
export const stageIcon = (id) => illustratedStages.has(id) ? id : 'overview';
