import { i18n } from "../locales/i18n";

/**
 * antd's number field writes "Increase Value" and "Decrease Value" on its spin buttons in English and offers no prop
 * for them. This renames them in the interface language, on every field, including the ones that open later in a
 * dialog, and again when the language changes.
 */
function label() {
  const spins: Array<[string, string]> = [
    [".ant-input-number-action-up", i18n.t("components.numberInput.increase")],
    [".ant-input-number-action-down", i18n.t("components.numberInput.decrease")],
  ];
  for (const [selector, text] of spins)
    for (const spin of document.querySelectorAll(selector))
      if (spin.getAttribute("aria-label") !== text) spin.setAttribute("aria-label", text);
}

new MutationObserver(label).observe(document.body, { childList: true, subtree: true });
i18n.on("languageChanged", label);
label();
