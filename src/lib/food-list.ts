// The "Nutrient-Rich Foods List" catalog — a faithful transcription of Layaka's
// paper form ("Patient paper english.docx"), used during a consultation to record
// what the patient actually eats.
//
// This module is the ONE source of truth for the form's content and its printed
// arrangement: the editor card renders from it, and the PDF renderer lays it out
// from the same data. They can't drift.
//
// Labels are reproduced exactly as printed, including the doc's own inconsistent
// capitalisation ("Nuts and seeds" / "Other Foods", "Plant-based proteins" /
// "Eggs and Dairy"). Don't "tidy" these — the printout is meant to match the paper.
//
// `column` records where each category sits on the printed page. The source
// document is a FOUR-column layout of floating text boxes (measured x-offsets
// 0.34" / 2.41" / 4.38" / 6.25" on US Letter, deliberately bleeding outside the
// 1" margins). The PDF reproduces that exactly; the on-screen form reflows
// responsively instead, because four columns of checkboxes are unusable inside
// the editor card on a narrow screen.

/** One tickable food item. `id` is stable and is what gets persisted. */
export type FoodListItem = {
  /** Stable id, `"<categoryId>.<slug>"`. Persisted — never renumber these.
   * The id is shared by both languages, so a form ticked in English prints
   * unchanged in Arabic and switching language never loses a selection. */
  id: string;
  /** Label exactly as printed on the English paper form. */
  label: string;
  /** Label from the Arabic paper form ("Patient paper 1.docx"), normalised to
   * standard Unicode Arabic — the source stored pre-shaped presentation forms
   * with some Persian/Urdu letters mixed in. See docs/known-issues.md §10. */
  labelAr: string;
};

/** A titled group of items, printed under a leaf-bulleted heading. */
export type FoodListCategory = {
  id: string;
  /** Heading exactly as printed on the English paper form. */
  title: string;
  /** Heading from the Arabic paper form. */
  titleAr: string;
  /** Which of the printed page's four columns this category sits in. In Arabic
   * the page is mirrored, so column 1 is the RIGHTMOST — see the renderer's
   * per-language layout table. */
  column: 1 | 2 | 3 | 4;
  items: readonly FoodListItem[];
};

/** Builds the `<categoryId>.<slug>` ids so the catalog below stays readable. */
function items(
  categoryId: string,
  entries: readonly [string, string, string][],
): FoodListItem[] {
  return entries.map(([slug, label, labelAr]) => ({
    id: `${categoryId}.${slug}`,
    label,
    labelAr,
  }));
}

/**
 * The eight categories, in printed order: down column 1, then column 2, and so on.
 * Iterating this array top-to-bottom reproduces the page's reading order.
 */
export const FOOD_LIST_CATEGORIES: readonly FoodListCategory[] = [
  {
    id: "vegetables",
    title: "Vegetables",
    titleAr: "خضروات",
    column: 1,
    items: items("vegetables", [
      ["artichoke", "Artichoke", "أرضي شوكي"],
      ["beetroot", "Beetroot", "شمندر"],
      ["broccoli", "Broccoli", "بروكلي"],
      ["cauliflower", "Cauliflower", "قرنبيط"],
      ["cabbage", "Cabbage", "ملفوف"],
      ["carrots", "Carrots", "جزر"],
      ["corn", "Corn", "ذرة"],
      ["green-beans", "Green Beans", "لوبياء"],
      ["cucumber", "Cucumber", "خيار"],
      ["zucchini", "Zucchini", "كوسا"],
      ["eggplant", "Eggplant", "باذنجان"],
      ["chicory", "Chicory", "هندباء"],
      ["peas", "Peas", "بازلاء"],
      ["garlic-onion", "Garlic / Onion", "ثوم/ بصل"],
      ["lettuce", "Lettuce", "خس"],
      ["mushrooms", "Mushrooms", "فطر"],
      ["pumpkin", "Pumpkin", "يقطين"],
      ["radish", "Radish", "فجل"],
      ["spinach", "Spinach", "سبانخ"],
      ["swiss-chard", "Swiss Chard", "سلق"],
      ["tomatoes", "Tomatoes", "طماطم"],
      ["peppers", "Peppers", "فلفل"],
      ["ginger", "Ginger", "زنجبيل"],
      ["herbs", "Herbs: Cabbage - Purslane - Parsley - Thyme - Mint - etc.", "أعشاب : كرنب - بقله - بقدونس زعتر - نعناع - الخ"],
    ]),
  },
  {
    id: "fruits",
    title: "Fruits",
    titleAr: "فواكه",
    column: 2,
    items: items("fruits", [
      ["loquat", "Loquat", "أكيدينيا"],
      ["apple", "Apple", "تفاح"],
      ["apricot", "Apricot", "مشمش"],
      ["avocado", "Avocado", "أفوكادو"],
      ["banana", "Banana", "موز"],
      ["berries", "Berries", "توت"],
      ["cherries", "Cherries", "كرز"],
      ["dates", "Dates", "تمر"],
      ["figs", "Figs", "تين"],
      ["grapes", "Grapes", "عنب"],
      ["melon-watermelon", "Melon / Watermelon", "شمام / بطيخ"],
      ["kiwi", "Kiwi", "كيوي"],
      ["orange", "Orange", "برتقال"],
      ["lemon", "Lemon", "ليمون"],
      ["mango", "Mango", "مانجو"],
      ["peach", "Peach", "خوخ"],
      ["pear", "Pear", "إجاص"],
      ["pineapple", "Pineapple", "أناناس"],
      ["pomegranate", "Pomegranate", "رمان"],
      ["strawberries", "Strawberries", "فراولة"],
      ["coconut", "Coconut", "جوز الهند"],
    ]),
  },
  {
    id: "nuts-and-seeds",
    title: "Nuts and seeds",
    titleAr: "مكسرات وبذور",
    column: 2,
    items: items("nuts-and-seeds", [
      ["almonds-walnuts-pistachios", "Almonds / Walnuts / Pistachios", "لوز/ جوز/ فستق"],
      ["peanuts", "Peanuts", "فول سوداني"],
      ["other-nuts", "Other Nuts", "مكسرات أخرى"],
      ["chia-seeds", "Chia Seeds", "بذور الشيا"],
    ]),
  },
  {
    id: "animal-proteins",
    title: "Animal proteins",
    titleAr: "بروتينات",
    column: 3,
    items: items("animal-proteins", [
      ["chicken-duck", "Chicken / Duck", "دجاج / بط"],
      ["turkey", "Turkey", "ديك رومي"],
      ["beef", "Beef", "لحم بقري"],
      ["veal", "Veal", "عجل"],
      ["lamb-mutton", "Lamb / Mutton", "خروف / لحم غنم"],
      ["goat-meat", "Goat Meat", "ماعز"],
      ["pork", "Pork", "لحم خنزير"],
      ["fish", "Fish", "سمك"],
      ["seafood", "Seafood", "ثمار البحر"],
    ]),
  },
  {
    id: "plant-based-proteins",
    title: "Plant-based proteins",
    titleAr: "بروتينات نباتية",
    column: 3,
    items: items("plant-based-proteins", [
      ["lentils", "Lentils", "عدس"],
      ["chickpeas-fava-beans", "Chickpeas / Fava Beans", "حمص / فول"],
      ["beans", "Beans", "فاصولياء"],
      ["soybeans", "Soybeans", "فول الصويا"],
      ["edamame", "Edamame", "إدامامي"],
    ]),
  },
  {
    id: "carbohydrates",
    title: "Carbohydrates",
    titleAr: "نشويات",
    column: 3,
    items: items("carbohydrates", [
      ["quinoa", "Quinoa", "كينوا"],
      ["whole-wheat", "Whole Wheat", "قمحة كاملة"],
      ["oats", "Oats", "شوفان"],
      ["pasta-pizza-flour", "Pasta / Pizza / Flour", "معكرونة/بيتزا/طحين"],
      ["rice", "Rice", "أرز"],
      ["potatoes", "Potatoes", "بطاطا"],
      ["bran", "Bran", "نخالة"],
      ["bulgur", "Bulgur", "برغل"],
    ]),
  },
  {
    id: "eggs-and-dairy",
    title: "Eggs and Dairy",
    titleAr: "بيض وألبان",
    column: 4,
    items: items("eggs-and-dairy", [
      ["eggs", "Eggs", "بيض"],
      ["cows-milk", "Cow's Milk", "حليب بقري"],
      ["goats-milk", "Goat's Milk", "حليب ماعز"],
      ["yogurt", "Regular / Greek Yogurt", "لبن عادي/ يوناني"],
      ["labneh-white-cheese", "Labneh / White Cheese", "لبنة / جبنة بيضاء"],
      ["yellow-cheese", "Yellow Cheese", "جبنة صفراء"],
      ["cream-ashta", "Cream / Ashta", "قشطة"],
      ["butter", "Butter", "زبدة"],
      ["ghee", "Ghee", "سمن"],
    ]),
  },
  {
    id: "other-foods",
    title: "Other Foods",
    titleAr: "أطعمة أخرى",
    column: 4,
    items: items("other-foods", [
      ["tea-matcha", "Tea / Matcha", "شاي / ماتشا"],
      ["black-coffee", "Black Coffee", "قهوة سوداء"],
      ["alcoholic-beverages", "Alcoholic Beverages", "مشروبات كحولية"],
      ["carbonated-beverages", "Carbonated Beverages", "مشروبات غازية"],
      ["canderel", "Canderel sweetener", "كاندريل"],
      ["honey", "Honey", "عسل"],
      ["tahini-sesame", "Tahini / Sesame", "طحينة / سمسم"],
      ["dark-chocolate", "Dark Chocolate", "شوكولاتة داكنة"],
      ["milk-chocolate", "Milk Chocolate", "شوكولاتة بالحليب"],
      ["olives", "Olives", "زيتون"],
      ["olive-oil", "Olive Oil", "زيت الزيتون"],
      ["canola-oil", "Canola Oil", "زيت الكانولا"],
      ["coconut-oil", "Coconut Oil", "زيت جوز الهند"],
      ["sunflower-oil", "Sunflower Oil", "زيت دوار الشمس"],
    ]),
  },
] as const;

/** Every valid item id, for validating what a client sends before we persist it. */
export const FOOD_LIST_ITEM_IDS: ReadonlySet<string> = new Set(
  FOOD_LIST_CATEGORIES.flatMap((c) => c.items.map((i) => i.id)),
);

/** Total tickable items on the form (94) — used in the editor's summary line. */
export const FOOD_LIST_ITEM_COUNT = FOOD_LIST_ITEM_IDS.size;

/**
 * Drops ids that aren't in the catalog and de-duplicates, preserving catalog
 * order. Used on both read and write so a stale or hand-crafted id can never
 * reach the PDF renderer or the checkbox state.
 */
export function normalizeFoodListSelections(ids: readonly string[]): string[] {
  const wanted = new Set(ids.filter((id) => FOOD_LIST_ITEM_IDS.has(id)));
  return FOOD_LIST_CATEGORIES.flatMap((c) => c.items.filter((i) => wanted.has(i.id)).map((i) => i.id));
}

/** The languages the form exists in — both are built. */
export const FOOD_LIST_LANGUAGES = ["en", "ar"] as const;
export type FoodListLanguage = (typeof FOOD_LIST_LANGUAGES)[number];

/** True when the language reads right-to-left (mirrored page, checkbox on the
 * right). Kept as a function so adding a third language stays a one-line change. */
export function isRtl(language: FoodListLanguage): boolean {
  return language === "ar";
}

/** The label to print for an item / category heading in the given language. */
export function itemLabel(item: FoodListItem, language: FoodListLanguage): string {
  return language === "ar" ? item.labelAr : item.label;
}
export function categoryTitle(category: FoodListCategory, language: FoodListLanguage): string {
  return language === "ar" ? category.titleAr : category.title;
}

/** Clinic details printed in the form's footer bar, verbatim from the document.
 * Identical in both editions — the Arabic form keeps this line in Latin script
 * with Western numerals, so it is deliberately NOT translated. */
export const FOOD_LIST_FOOTER =
  "LAYAKA Zalka | Tel: +961 3 140910 / +961 3 150810 | info@layakacare.com | www.layakacare.com";

/** Title block printed under the header band, verbatim from each document. */
export const FOOD_LIST_TITLE = "Nutrient-Rich Foods List";
export const FOOD_LIST_SUBTITLE =
  "(For use in assessing patients’ dietary intake at Layaka clinic)";
export const FOOD_LIST_TITLE_AR = "قائمة الأطعمة الغنية بالعناصر الغذائية";
export const FOOD_LIST_SUBTITLE_AR =
  "(للاستخدام في تقييم النظام الغذائي للمرضى في عيادة لياقة)";

/** The two fill-in fields at the foot of the form. */
export const FOOD_LIST_FIELD_LABELS = {
  en: { name: "Name:", notes: "Notes:" },
  ar: { name: "الاسم:", notes: "ملاحظات:" },
} as const;

export function foodListTitle(language: FoodListLanguage): string {
  return language === "ar" ? FOOD_LIST_TITLE_AR : FOOD_LIST_TITLE;
}
export function foodListSubtitle(language: FoodListLanguage): string {
  return language === "ar" ? FOOD_LIST_SUBTITLE_AR : FOOD_LIST_SUBTITLE;
}

/** The specialities strip inside the teal header band, verbatim from the document. */
export const FOOD_LIST_SPECIALITIES = [
  "PREVENTIVE MEDICINE",
  "ENDOCRINOLOGY",
  "METABOLISM & OBESITY",
  "WEIGHT MANAGEMENT",
] as const;
