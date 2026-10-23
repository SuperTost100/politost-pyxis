import { Input } from "antd";
import { useTranslation } from "react-i18next";

/** A card's front and back while it is edited, on the flashcards page and in the card browser. */
export function CardFaceFields({
  idPrefix,
  front,
  back,
  onFront,
  onBack,
}: {
  /** Makes the field ids `<idPrefix>-front` and `<idPrefix>-back`. */
  idPrefix: string;
  front: string;
  back: string;
  onFront: (value: string) => void;
  onBack: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <label className="label" htmlFor={`${idPrefix}-front`}>
        {t("cards.front")}
      </label>
      <Input.TextArea
        id={`${idPrefix}-front`}
        autoSize={{ minRows: 2, maxRows: 8 }}
        value={front}
        onChange={(event) => onFront(event.target.value)}
      />
      <label className="label" htmlFor={`${idPrefix}-back`}>
        {t("cards.back")}
      </label>
      <Input.TextArea
        id={`${idPrefix}-back`}
        autoSize={{ minRows: 2, maxRows: 8 }}
        value={back}
        onChange={(event) => onBack(event.target.value)}
      />
    </>
  );
}
