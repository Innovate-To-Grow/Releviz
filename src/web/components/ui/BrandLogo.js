import Image from "next/image";
import Link from "next/link";

const BRAND_ASSETS = {
  mark: {
    src: "/brand/releviz-mark.png",
    width: 512,
    height: 512,
  },
  wordmark: {
    src: "/brand/releviz-logo.png",
    width: 1200,
    height: 426,
  },
};

export default function BrandLogo({
  variant = "wordmark",
  alt = "Releviz",
  className,
  priority = false,
}) {
  const asset = BRAND_ASSETS[variant] || BRAND_ASSETS.wordmark;

  return (
    <Image
      src={asset.src}
      alt={alt}
      width={asset.width}
      height={asset.height}
      className={className}
      priority={priority}
    />
  );
}

export function BrandHomeLink({
  variant = "wordmark",
  className = "brand-home-link",
  logoClassName,
  priority = false,
}) {
  return (
    <Link href="/" className={className} aria-label="Releviz home">
      <BrandLogo
        variant={variant}
        alt=""
        className={logoClassName}
        priority={priority}
      />
    </Link>
  );
}
