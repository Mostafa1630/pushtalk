import { useEffect, useState } from "react";
import { useLanguage } from "../i18n";

export function ScrollToTopButton() {
  const { t } = useLanguage();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const nestedScroll = Array.from(
          document.querySelectorAll<HTMLElement>(".messages, .members, .page"),
        ).some((element) => element.scrollTop > 120);
        setVisible(window.scrollY > 120 || nestedScroll);
      });
    };

    window.addEventListener("scroll", update, { capture: true, passive: true });
    update();
    return () => {
      window.removeEventListener("scroll", update, true);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  if (!visible) return null;

  return (
    <button
      type="button"
      className="scroll-top"
      aria-label={t("scrollToTop")}
      title={t("scrollToTop")}
      onClick={() => {
        window.scrollTo({ top: 0, behavior: "smooth" });
        document
          .querySelectorAll<HTMLElement>(".messages, .members, .page")
          .forEach((element) => {
            element.scrollTo({ top: 0, behavior: "smooth" });
          });
      }}
    >
      <span aria-hidden="true">↑</span>
    </button>
  );
}
