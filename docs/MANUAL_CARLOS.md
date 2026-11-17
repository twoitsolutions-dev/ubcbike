# UBC Commerce Hub — Quick Operating Guide (Carlos Mirabal)

**UBC Commerce Hub** (`https://ubc-hub.twoitsolutions.com`) is your daily control panel for **University Bicycle Center (UBC)**. It connects your **Shopify Online Store**, **Lightspeed Retail R-Series POS**, and **B2B Vendor Catalogs** (QBP, JBI, Specialized) using the same familiar section layout as Lightspeed — while keeping **In-Store Stock** strictly separate from **Vendor Stock**, protecting **MAP & minimum margins**, and never placing vendor orders without your manual approval.

---

## 1. Main Navigation (Lightspeed R-Series Layout)

- **Dashboard:** Daily snapshot of online catalog health, open Special Orders, active promotions, and items needing your attention.
- **Inventory:**
  - **Item Search:** Unified catalog workspace with 4 tabs:
    - *All Items* — Search by name, brand, SKU, UPC, MPN, or Lightspeed Item ID.
    - *In-Store Stock* — Physical floor inventory at UBC (never summed with distributor inventory).
    - *Vendor Catalog Only* — `0` on the UBC floor, available online via *Special Order* from QBP, JBI, or Specialized.
    - *Margins & MAP* — Sorted from lowest to highest margin so low-margin or MAP-sensitive items stand out immediately.
  - **Special Orders:** Customer orders from Shopify, clearly distinguishing *In-Store Stock* pickups/shipments from distributor *Special Orders*.
  - **Purchase Orders:** B2B buying worksheets ready for you to copy Vendor Part #s and place orders directly on QBP, JBI, or Specialized B2B.
  - **Vendor Catalogs:** Distributor feeds & matching workspace (*Vendor Catalogs & Matching* + *Feed Sync & MAP Quarantine*).
- **Pricing & System:**
  - **Promotions / Price Rules:** 3-step promotion builder with 1-click presets and automatic MAP + minimum-margin guardrails.
  - **Settings & Sync:** Default margin/lead-time rules, *Connections*, *Activity & Logs*, and *Store Simulator*.

---

## 2. Special Orders & Purchase Orders (Your Real B2B Workflow)

The Hub **never submits automated orders to distributors behind your back**. Instead, it prepares clean B2B worksheets so you can combine customer Special Orders with regular shop restock on QBP, JBI, or Specialized to hit free-freight thresholds:

1. **Automatic Special Order intake from Shopify:**
   When a customer buys an item online that has `0` physical units at UBC (available via distributor), the order lands in **Special Orders** (`Awaiting Approval`) and creates a worksheet in **Purchase Orders → To Order in B2B**.
2. **Copy Vendor Part # & open B2B portal:**
   - Open **Purchase Orders** (`#/purchasing`).
   - Click **Copy SKU** (copies the exact `Vendor Part #`, e.g., `SPEC-94424-56`) or **Copy SKU + Qty** for B2B Quick Order forms.
   - Click **Open QBP.com**, **Open JBI.bike**, or **Open Specialized B2B** to jump straight to the vendor portal.
3. **Approve & record your B2B confirmation:**
   - Click **Approve B2B purchase** in the Hub (re-verifies live vendor cost and stock before you buy).
   - After placing the order on the vendor's B2B site, click **Mark ordered in B2B** and save the **Vendor Order / Confirmation #** and tracking/ETA.
4. **Shared SKU protection (`Shared SKU` badge):**
   - If two open customer Special Orders include the exact same SKU, the Hub highlights **`Shared SKU: also in #XXXX`** so incoming units are allocated cleanly order-by-order (FIFO).
5. **Receiving & customer pickup:**
   - When the shipment arrives at UBC, click **Mark received at UBC** in *Purchase Orders* and update the customer order to **Ready for pickup** (or **Completed**) in *Special Orders*.

---

## 3. Promotions / Price Rules (Safe 3-Step Wizard)

1. Go to **Promotions / Price Rules → + New Price Rule**.
2. **1-Click Presets (optional):** Pick *Online Promo (-15%)*, *Black Friday (-20%)*, *Holiday Sale*, or *Clearance (-30%)*.
3. **Step 1 — Which items are included?** Choose the whole store or click visual **Category** / **Brand** chips (e.g., *Helmets*, *Tires & Tubes*, *Hydration*, *Bell*).
4. **Step 2 — Discount & Channel:** Set `% off` or `$ off`, `.99` retail rounding, and channel (*Online Only — Shopify* for everyday web promos, or *Storewide — Online + Lightspeed POS* for major events). A live `$100` example previews the exact math as you type.
5. **Step 3 — Margin & MAP Guardrails:** Set your minimum margin floor (e.g., `20%`). Contractual **MAP** is enforced automatically — Specialized and other MAP-protected items will never drop below MAP unless an Owner explicitly logs a written brand exception.
6. **Preview Prices → Approve & Publish:** Inspect every item in **Will apply** vs. **Blocked by MAP / margin** before anything touches Shopify. When the sale ends, click **End & Restore Original Prices** to roll prices back cleanly.

---

## 4. Vendor Catalogs, Matching & MAP Quarantine

- **Vendor Catalogs & Matching (`#/suppliers`):** Upload distributor CSV feeds (QBP, JBI, Specialized) and review fuzzy product matches without a barcode by clicking **Same item** or **Different**.
- **Feed Sync & MAP Quarantine (`#/pipeline`):** Monitors vendor feed freshness (48h watchdog), logs supplier cost changes, and **quarantines** any item whose updated vendor MAP rises above your current online price — holding it safely until you review and approve a compliant retail price.

---

## 5. Sandbox Demo Examples Ready to Test Right Now

We pre-loaded **1 clean, realistic bike-shop example of every workflow** in your Sandbox so you can inspect them immediately or run your own tests:

| Feature / Scenario | Live Example Ready in Hub & Shopify |
| :--- | :--- |
| **10 Authentic Cycling Products** | Specialized Tarmac SL7 (`$2,799.99`), Turbo Vado 4.0 (`$3,249.99`), Power Expert Saddle (`$159.99` — `16.9%` low-margin warning), Bell Z20 MIPS Helmet, Skratch Labs Hydration, Continental GP5000 Tire, Surly Midnight Special Frame, Shimano Ultegra Di2 Groupset, Park Tool PCS-10.3 Stand, Garmin Rally RS200 Pedals. |
| **Special Order Waiting for B2B PO** | Order **`#UBC-1044`** (`PO-UBC-1044` — Shimano Ultegra R8170 Di2 Groupset via QBP `QBP-DR8170`) in **Purchase Orders → To Order in B2B**. |
| **Special Order In Transit from Vendor** | Order **`#UBC-1043`** (`PO-UBC-1043` — Park Tool PCS-10.3 Stand via JBI `JBI-TL4103`, Ref `JBI-WEB-774920`, UPS `1Z999AA10123456784`). |
| **In-Store Stock Pickup & Completed Orders** | Order **`#UBC-1042`** (*Ready for pickup* — 2× Continental GP5000 from UBC floor stock) and **`#UBC-1041`** (*Completed*). |
| **Live Online Promotion (15% Off + MAP Guardrail)** | **Helmet, Tire & Hydration Promo — 15% Off Online** (`#/promotions`): Bell Z20 MIPS (`$149.99` → **`$126.99`**) and Skratch Labs (`$24.99` → **`$20.99`**) are discounted live on Shopify, while **Continental GP5000** stayed protected at **`$79.99`** by its **`$74.99` MAP floor**! |
| **Draft Storewide Event Preview** | **Black Friday Storewide Preview — 10% Off (.99)** ready to preview or edit in **Promotions / Price Rules**. |
| **Vendor Match Review (2 items)** | `SPEC-UNVERIFIED-56` and `QBP-HE8821-ALT` waiting for **Same item / Different** in **Vendor Catalogs**. |
| **MAP Quarantine Alert (1 item)** | `UBC-CON-GP5K-28` held in **Vendor Catalogs → Feed Sync & MAP Quarantine** (JBI reported a new `$84.99` MAP above the `$79.99` retail price), plus `UBC-SHM-R8170-GRP` staged & ready. |
| **7 Storefront Seasonal Themes (1-Click Switcher)** | Open `https://ubcbike-hub.myshopify.com/` and use the **Themes** bar at the bottom-left (or the quick-launch buttons on your Hub Dashboard) to switch instantly across UBC's full retail year: **Classic UBC**, **Spring & Bike Month**, **July 4th Summer**, **USF Back to Campus** (with USF Bulls crest & student perks), **Veterans & Heroes** (honoring Manny's military service + everyday Veteran, Police & Student discounts), **Black Friday (Full Dark Mode)**, and **Christmas**. |
