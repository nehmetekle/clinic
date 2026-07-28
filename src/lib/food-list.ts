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
  /** Stable id, `"<categoryId>.<slug>"`. Persisted — never renumber these. */
  id: string;
  /** Label exactly as printed on the paper form. */
  label: string;
};

/** A titled group of items, printed under a leaf-bulleted heading. */
export type FoodListCategory = {
  id: string;
  /** Heading exactly as printed on the paper form. */
  title: string;
  /** Which of the printed page's four columns this category sits in. */
  column: 1 | 2 | 3 | 4;
  items: readonly FoodListItem[];
};

/** Builds the `<categoryId>.<slug>` ids so the catalog below stays readable. */
function items(categoryId: string, entries: readonly [string, string][]): FoodListItem[] {
  return entries.map(([slug, label]) => ({ id: `${categoryId}.${slug}`, label }));
}

/**
 * The eight categories, in printed order: down column 1, then column 2, and so on.
 * Iterating this array top-to-bottom reproduces the page's reading order.
 */
export const FOOD_LIST_CATEGORIES: readonly FoodListCategory[] = [
  {
    id: "vegetables",
    title: "Vegetables",
    column: 1,
    items: items("vegetables", [
      ["artichoke", "Artichoke"],
      ["beetroot", "Beetroot"],
      ["broccoli", "Broccoli"],
      ["cauliflower", "Cauliflower"],
      ["cabbage", "Cabbage"],
      ["carrots", "Carrots"],
      ["corn", "Corn"],
      ["green-beans", "Green Beans"],
      ["cucumber", "Cucumber"],
      ["zucchini", "Zucchini"],
      ["eggplant", "Eggplant"],
      ["chicory", "Chicory"],
      ["peas", "Peas"],
      ["garlic-onion", "Garlic / Onion"],
      ["lettuce", "Lettuce"],
      ["mushrooms", "Mushrooms"],
      ["pumpkin", "Pumpkin"],
      ["radish", "Radish"],
      ["spinach", "Spinach"],
      ["swiss-chard", "Swiss Chard"],
      ["tomatoes", "Tomatoes"],
      ["peppers", "Peppers"],
      ["ginger", "Ginger"],
      ["herbs", "Herbs: Cabbage - Purslane - Parsley - Thyme - Mint - etc."],
    ]),
  },
  {
    id: "fruits",
    title: "Fruits",
    column: 2,
    items: items("fruits", [
      ["loquat", "Loquat"],
      ["apple", "Apple"],
      ["apricot", "Apricot"],
      ["avocado", "Avocado"],
      ["banana", "Banana"],
      ["berries", "Berries"],
      ["cherries", "Cherries"],
      ["dates", "Dates"],
      ["figs", "Figs"],
      ["grapes", "Grapes"],
      ["melon-watermelon", "Melon / Watermelon"],
      ["kiwi", "Kiwi"],
      ["orange", "Orange"],
      ["lemon", "Lemon"],
      ["mango", "Mango"],
      ["peach", "Peach"],
      ["pear", "Pear"],
      ["pineapple", "Pineapple"],
      ["pomegranate", "Pomegranate"],
      ["strawberries", "Strawberries"],
      ["coconut", "Coconut"],
    ]),
  },
  {
    id: "nuts-and-seeds",
    title: "Nuts and seeds",
    column: 2,
    items: items("nuts-and-seeds", [
      ["almonds-walnuts-pistachios", "Almonds / Walnuts / Pistachios"],
      ["peanuts", "Peanuts"],
      ["other-nuts", "Other Nuts"],
      ["chia-seeds", "Chia Seeds"],
    ]),
  },
  {
    id: "animal-proteins",
    title: "Animal proteins",
    column: 3,
    items: items("animal-proteins", [
      ["chicken-duck", "Chicken / Duck"],
      ["turkey", "Turkey"],
      ["beef", "Beef"],
      ["veal", "Veal"],
      ["lamb-mutton", "Lamb / Mutton"],
      ["goat-meat", "Goat Meat"],
      ["pork", "Pork"],
      ["fish", "Fish"],
      ["seafood", "Seafood"],
    ]),
  },
  {
    id: "plant-based-proteins",
    title: "Plant-based proteins",
    column: 3,
    items: items("plant-based-proteins", [
      ["lentils", "Lentils"],
      ["chickpeas-fava-beans", "Chickpeas / Fava Beans"],
      ["beans", "Beans"],
      ["soybeans", "Soybeans"],
      ["edamame", "Edamame"],
    ]),
  },
  {
    id: "carbohydrates",
    title: "Carbohydrates",
    column: 3,
    items: items("carbohydrates", [
      ["quinoa", "Quinoa"],
      ["whole-wheat", "Whole Wheat"],
      ["oats", "Oats"],
      ["pasta-pizza-flour", "Pasta / Pizza / Flour"],
      ["rice", "Rice"],
      ["potatoes", "Potatoes"],
      ["bran", "Bran"],
      ["bulgur", "Bulgur"],
    ]),
  },
  {
    id: "eggs-and-dairy",
    title: "Eggs and Dairy",
    column: 4,
    items: items("eggs-and-dairy", [
      ["eggs", "Eggs"],
      ["cows-milk", "Cow's Milk"],
      ["goats-milk", "Goat's Milk"],
      ["yogurt", "Regular / Greek Yogurt"],
      ["labneh-white-cheese", "Labneh / White Cheese"],
      ["yellow-cheese", "Yellow Cheese"],
      ["cream-ashta", "Cream / Ashta"],
      ["butter", "Butter"],
      ["ghee", "Ghee"],
    ]),
  },
  {
    id: "other-foods",
    title: "Other Foods",
    column: 4,
    items: items("other-foods", [
      ["tea-matcha", "Tea / Matcha"],
      ["black-coffee", "Black Coffee"],
      ["alcoholic-beverages", "Alcoholic Beverages"],
      ["carbonated-beverages", "Carbonated Beverages"],
      ["canderel", "Canderel sweetener"],
      ["honey", "Honey"],
      ["tahini-sesame", "Tahini / Sesame"],
      ["dark-chocolate", "Dark Chocolate"],
      ["milk-chocolate", "Milk Chocolate"],
      ["olives", "Olives"],
      ["olive-oil", "Olive Oil"],
      ["canola-oil", "Canola Oil"],
      ["coconut-oil", "Coconut Oil"],
      ["sunflower-oil", "Sunflower Oil"],
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

/** The languages the form exists in. Arabic is declared but not yet built. */
export const FOOD_LIST_LANGUAGES = ["en", "ar"] as const;
export type FoodListLanguage = (typeof FOOD_LIST_LANGUAGES)[number];

/** Clinic details printed in the form's footer bar, verbatim from the document. */
export const FOOD_LIST_FOOTER =
  "LAYAKA Zalka | Tel: +961 3 140910 / +961 3 150810 | info@layakacare.com | www.layakacare.com";

/** Title block printed under the header band, verbatim from the document. */
export const FOOD_LIST_TITLE = "Nutrient-Rich Foods List";
export const FOOD_LIST_SUBTITLE =
  "(For use in assessing patients’ dietary intake at Layaka clinic)";

/** The specialities strip inside the teal header band, verbatim from the document. */
export const FOOD_LIST_SPECIALITIES = [
  "PREVENTIVE MEDICINE",
  "ENDOCRINOLOGY",
  "METABOLISM & OBESITY",
  "WEIGHT MANAGEMENT",
] as const;
