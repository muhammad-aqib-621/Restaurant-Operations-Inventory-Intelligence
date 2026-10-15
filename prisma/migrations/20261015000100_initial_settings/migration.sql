CREATE TABLE "RestaurantSettings" (
    "id" TEXT NOT NULL DEFAULT 'primary',
    "name" VARCHAR(120) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'PKR',
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'Asia/Karachi',
    "taxRate" DECIMAL(7,6) NOT NULL DEFAULT 0,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "RestaurantSettings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RestaurantSettings_singleton" CHECK ("id" = 'primary'),
    CONSTRAINT "RestaurantSettings_taxRate_range" CHECK ("taxRate" >= 0 AND "taxRate" <= 1),
    CONSTRAINT "RestaurantSettings_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$'),
    CONSTRAINT "RestaurantSettings_name_nonempty" CHECK (length(trim("name")) > 0)
);
