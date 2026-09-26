import Link from "next/link";

import FirecrawlIcon from "@/components/shared/firecrawl-icon/firecrawl-icon";
import Logo from "@/components/shared/header/_svg/Logo";

export default function HeaderBrandKit() {
  return (
    <div className="relative">
      <Link className="flex items-center gap-2 relative" href="/">
        <FirecrawlIcon className="size-28 -top-2 relative" />
        <Logo />
      </Link>
    </div>
  );
}
