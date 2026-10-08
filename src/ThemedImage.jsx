import { motion } from 'motion/react';
import { useTheme } from './Theme.jsx';
import './themed-image.css';

export default function ThemedImage({
  light,
  dark,
  lightSrcSet,
  darkSrcSet,
  sizes,
  lightAlt = '',
  darkAlt = '',
  priority = false,
  className = '',
  animate,
  transition
}) {
  const { theme } = useTheme();
  const label = theme === 'dark' ? darkAlt : lightAlt;
  return (
    <motion.span
      className={`themed-art ${className}`}
      role={label ? 'img' : undefined}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : true}
      animate={animate}
      transition={transition}
    >
      {[
        ['light', light, lightSrcSet],
        ['dark', dark, darkSrcSet]
      ].map(([variant, src, srcSet]) => (
        <img
          key={variant}
          className={`theme-art-layer theme-art-${variant}`}
          src={src}
          srcSet={srcSet}
          sizes={sizes}
          alt=""
          loading={priority ? 'eager' : 'lazy'}
          fetchPriority={priority && theme === variant ? 'high' : 'low'}
          decoding="async"
          width="1024"
          height="1024"
        />
      ))}
    </motion.span>
  );
}
