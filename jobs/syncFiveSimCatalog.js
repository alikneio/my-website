// /jobs/syncFiveSimCatalog.js

module.exports = function makeSyncFiveSimCatalogJob(promisePool) {
  const {
    getCountries,
    getProducts,
    getPrices,
  } = require('../services/fivesim');

  const BATCH_SIZE = 250;

  function chunkArray(items, size) {
    const chunks = [];

    for (let i = 0; i < items.length; i += size) {
      chunks.push(items.slice(i, i + size));
    }

    return chunks;
  }

  function firstObjectKey(value) {
    if (!value || typeof value !== 'object') {
      return null;
    }

    const keys = Object.keys(value);
    return keys.length ? keys[0] : null;
  }

  function humanizeCode(code) {
    return String(code || '')
      .replace(/[_-]+/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/\b\w/g, (letter) => letter.toUpperCase())
      .trim();
  }

  function safeNumber(value, fallback = 0) {
    const number = Number(value);

    return Number.isFinite(number)
      ? number
      : fallback;
  }

  function normalizeCountries(payload) {
    if (!payload || typeof payload !== 'object') {
      throw new Error('Invalid countries response from 5SIM');
    }

    const rows = [];

    for (const [countryCodeRaw, countryDataRaw] of Object.entries(payload)) {
      const countryCode = String(countryCodeRaw || '')
        .trim()
        .toLowerCase();

      if (!countryCode) {
        continue;
      }

      const countryData =
        countryDataRaw && typeof countryDataRaw === 'object'
          ? countryDataRaw
          : {};

      const iso = firstObjectKey(countryData.iso);
      const prefix = firstObjectKey(countryData.prefix);

      rows.push({
        code: countryCode,
        providerName:
          String(countryData.text_en || '').trim() ||
          humanizeCode(countryCode),
        iso: iso ? String(iso).toLowerCase() : null,
        prefix: prefix ? String(prefix) : null,
      });
    }

    return rows;
  }

  function normalizeProducts(payload) {
    if (!payload || typeof payload !== 'object') {
      return [];
    }

    const rows = [];

    for (const [productCodeRaw, productDataRaw] of Object.entries(payload)) {
      const productCode = String(productCodeRaw || '')
        .trim()
        .toLowerCase();

      if (!productCode) {
        continue;
      }

      const productData =
        productDataRaw && typeof productDataRaw === 'object'
          ? productDataRaw
          : {};

      rows.push({
        productCode,
        providerName: humanizeCode(productCode),
        category:
          String(
            productData.Category ||
            productData.category ||
            'activation'
          )
            .trim()
            .toLowerCase() || 'activation',
      });
    }

    return rows;
  }

  /*
   * الشكل المتوقع:
   *
   * {
   *   usa: {
   *     telegram: {
   *       virtual28: {
   *         cost: 0.89,
   *         count: 78943,
   *         rate: 0
   *       }
   *     }
   *   }
   * }
   */
  function normalizePrices(payload) {
    if (!payload || typeof payload !== 'object') {
      throw new Error('Invalid prices response from 5SIM');
    }

    const priceRows = [];
    const serviceCodes = new Set();
    const operatorCodes = new Set();

    for (
      const [countryCodeRaw, countryProductsRaw]
      of Object.entries(payload)
    ) {
      const countryCode = String(countryCodeRaw || '')
        .trim()
        .toLowerCase();

      if (
        !countryCode ||
        !countryProductsRaw ||
        typeof countryProductsRaw !== 'object'
      ) {
        continue;
      }

      for (
        const [serviceCodeRaw, operatorsRaw]
        of Object.entries(countryProductsRaw)
      ) {
        const serviceCode = String(serviceCodeRaw || '')
          .trim()
          .toLowerCase();

        if (
          !serviceCode ||
          !operatorsRaw ||
          typeof operatorsRaw !== 'object'
        ) {
          continue;
        }

        serviceCodes.add(serviceCode);

        for (
          const [operatorCodeRaw, offerRaw]
          of Object.entries(operatorsRaw)
        ) {
          const operatorCode = String(operatorCodeRaw || '')
            .trim()
            .toLowerCase();

          if (
            !operatorCode ||
            !offerRaw ||
            typeof offerRaw !== 'object'
          ) {
            continue;
          }

          const providerPrice = safeNumber(
            offerRaw.cost ?? offerRaw.Cost,
            0
          );

          const availableCount = Math.max(
            0,
            Math.trunc(
              safeNumber(
                offerRaw.count ??
                offerRaw.Count ??
                offerRaw.Qty,
                0
              )
            )
          );

          const rateValue =
            offerRaw.rate ??
            offerRaw.Rate ??
            null;

          const deliveryRate =
            rateValue === null ||
            rateValue === undefined ||
            rateValue === ''
              ? null
              : safeNumber(rateValue, 0);

          if (providerPrice < 0) {
            continue;
          }

          operatorCodes.add(operatorCode);

          priceRows.push({
            countryCode,
            serviceCode,
            operatorCode,
            providerPrice,
            availableCount,
            deliveryRate,
          });
        }
      }
    }

    return {
      priceRows,
      serviceCodes: Array.from(serviceCodes),
      operatorCodes: Array.from(operatorCodes),
    };
  }

  async function insertCountries(conn, countries) {
    for (const batch of chunkArray(countries, BATCH_SIZE)) {
      if (!batch.length) continue;

      const placeholders = batch
        .map(() => '(?, ?, ?, ?)')
        .join(', ');

      const params = [];

      for (const country of batch) {
        params.push(
          country.code,
          country.providerName,
          country.iso,
          country.prefix
        );
      }

      /*
       * custom_name:
       * - عند الإنشاء نعطيه الاسم الرسمي.
       * - عند التحديث لا نلمسه حتى يبقى تعديل الأدمن محفوظ.
       */
      await conn.query(
        `
        INSERT INTO fivesim_countries
          (
            code,
            custom_name,
            iso,
            prefix
          )
        VALUES ${placeholders}
        ON DUPLICATE KEY UPDATE
          iso = VALUES(iso),
          prefix = VALUES(prefix),
          updated_at = CURRENT_TIMESTAMP
        `,
        params
      );
    }
  }

  async function insertServices(conn, services) {
    for (const batch of chunkArray(services, BATCH_SIZE)) {
      if (!batch.length) continue;

      const placeholders = batch
        .map(() => '(?, ?, ?)')
        .join(', ');

      const params = [];

      for (const service of batch) {
        params.push(
          service.productCode,
          service.providerName,
          service.category
        );
      }

      await conn.query(
        `
        INSERT INTO fivesim_services
          (
            product_code,
            provider_name,
            category
          )
        VALUES ${placeholders}
        ON DUPLICATE KEY UPDATE
          provider_name = VALUES(provider_name),
          category = VALUES(category),
          updated_at = CURRENT_TIMESTAMP
        `,
        params
      );
    }
  }

  async function insertOperators(conn, operatorCodes) {
    for (const batch of chunkArray(operatorCodes, BATCH_SIZE)) {
      if (!batch.length) continue;

      const placeholders = batch
        .map(() => '(?)')
        .join(', ');

      await conn.query(
        `
        INSERT INTO fivesim_operators
          (operator_code)
        VALUES ${placeholders}
        ON DUPLICATE KEY UPDATE
          updated_at = CURRENT_TIMESTAMP
        `,
        batch
      );
    }
  }

  async function loadIdMap(conn, table, codeColumn) {
    const [rows] = await conn.query(
      `
      SELECT id, ${codeColumn} AS code
      FROM ${table}
      `
    );

    return new Map(
      rows.map((row) => [
        String(row.code).toLowerCase(),
        Number(row.id),
      ])
    );
  }

  async function insertPrices(
    conn,
    priceRows,
    countryMap,
    serviceMap,
    operatorMap
  ) {
    let savedCount = 0;
    let skippedCount = 0;

    const preparedRows = [];

    for (const row of priceRows) {
      const countryId = countryMap.get(row.countryCode);
      const serviceId = serviceMap.get(row.serviceCode);
      const operatorId = operatorMap.get(row.operatorCode);

      if (!countryId || !serviceId || !operatorId) {
        skippedCount += 1;
        continue;
      }

      preparedRows.push({
        countryId,
        serviceId,
        operatorId,
        providerPrice: row.providerPrice,
        availableCount: row.availableCount,
        deliveryRate: row.deliveryRate,
        isOutOfStock: row.availableCount > 0 ? 0 : 1,
      });
    }

    for (const batch of chunkArray(preparedRows, BATCH_SIZE)) {
      if (!batch.length) continue;

      const placeholders = batch
        .map(() => '(?, ?, ?, ?, ?, ?, ?, NOW())')
        .join(', ');

      const params = [];

      for (const row of batch) {
        params.push(
          row.countryId,
          row.serviceId,
          row.operatorId,
          row.providerPrice,
          row.availableCount,
          row.deliveryRate,
          row.isOutOfStock
        );
      }

      await conn.query(
        `
        INSERT INTO fivesim_prices
          (
            country_id,
            service_id,
            operator_id,
            provider_price,
            available_count,
            delivery_rate,
            is_out_of_stock,
            last_synced_at
          )
        VALUES ${placeholders}
        ON DUPLICATE KEY UPDATE
          provider_price = VALUES(provider_price),
          available_count = VALUES(available_count),
          delivery_rate = VALUES(delivery_rate),
          is_out_of_stock = VALUES(is_out_of_stock),
          last_synced_at = NOW()
        `,
        params
      );

      savedCount += batch.length;
    }

    return {
      savedCount,
      skippedCount,
    };
  }

  return async function syncFiveSimCatalog() {
    const startedAt = Date.now();

    let logId = null;
    let conn = null;

    console.log('🔄 5SIM catalog sync started...');

    try {
      const [logResult] = await promisePool.query(
        `
        INSERT INTO fivesim_sync_logs
          (
            sync_type,
            status,
            started_at
          )
        VALUES
          ('catalog', 'running', NOW())
        `
      );

      logId = logResult.insertId;

      /*
       * طلبات API خارج Transaction:
       * لا نريد إبقاء اتصال MySQL محجوزًا أثناء انتظار 5SIM.
       */
      const [
        countriesPayload,
        productsPayload,
        pricesPayload,
      ] = await Promise.all([
        getCountries(),
        getProducts({
          country: 'any',
          operator: 'any',
        }),
        getPrices(),
      ]);

      const countries = normalizeCountries(countriesPayload);
      const productsFromEndpoint = normalizeProducts(productsPayload);

      const {
        priceRows,
        serviceCodes,
        operatorCodes,
      } = normalizePrices(pricesPayload);

      /*
       * في حال خدمة موجودة بالأسعار وغير موجودة برد products،
       * ننشئها أيضًا حتى لا نخسر أي Price row.
       */
      const serviceMapByCode = new Map();

      for (const product of productsFromEndpoint) {
        serviceMapByCode.set(product.productCode, product);
      }

      for (const serviceCode of serviceCodes) {
        if (!serviceMapByCode.has(serviceCode)) {
          serviceMapByCode.set(serviceCode, {
            productCode: serviceCode,
            providerName: humanizeCode(serviceCode),
            category: 'activation',
          });
        }
      }

      const services = Array.from(serviceMapByCode.values());

      console.log('📦 5SIM payload normalized:', {
        countries: countries.length,
        services: services.length,
        operators: operatorCodes.length,
        prices: priceRows.length,
      });

      if (!countries.length) {
        throw new Error('5SIM sync returned zero countries');
      }

      if (!services.length) {
        throw new Error('5SIM sync returned zero services');
      }

      if (!priceRows.length) {
        throw new Error('5SIM sync returned zero prices');
      }

      conn = await promisePool.getConnection();
      await conn.beginTransaction();

      await insertCountries(conn, countries);
      await insertServices(conn, services);
      await insertOperators(conn, operatorCodes);

      const countryMap = await loadIdMap(
        conn,
        'fivesim_countries',
        'code'
      );

      const serviceIdMap = await loadIdMap(
        conn,
        'fivesim_services',
        'product_code'
      );

      const operatorMap = await loadIdMap(
        conn,
        'fivesim_operators',
        'operator_code'
      );

      const priceResult = await insertPrices(
        conn,
        priceRows,
        countryMap,
        serviceIdMap,
        operatorMap
      );

      await conn.commit();

      const durationMs = Date.now() - startedAt;

      if (logId) {
        await promisePool.query(
          `
          UPDATE fivesim_sync_logs
          SET
            status = 'completed',
            countries_count = ?,
            services_count = ?,
            operators_count = ?,
            prices_count = ?,
            finished_at = NOW(),
            duration_ms = ?
          WHERE id = ?
          `,
          [
            countries.length,
            services.length,
            operatorCodes.length,
            priceResult.savedCount,
            durationMs,
            logId,
          ]
        );
      }

      const result = {
        success: true,
        countries: countries.length,
        services: services.length,
        operators: operatorCodes.length,
        prices: priceResult.savedCount,
        skippedPrices: priceResult.skippedCount,
        durationMs,
      };

      console.log('✅ 5SIM catalog sync completed:', result);

      return result;
    } catch (error) {
      if (conn) {
        try {
          await conn.rollback();
        } catch (rollbackError) {
          console.error(
            '❌ 5SIM sync rollback error:',
            rollbackError.message || rollbackError
          );
        }
      }

      const durationMs = Date.now() - startedAt;

      if (logId) {
        try {
          await promisePool.query(
            `
            UPDATE fivesim_sync_logs
            SET
              status = 'failed',
              error_message = ?,
              finished_at = NOW(),
              duration_ms = ?
            WHERE id = ?
            `,
            [
              String(error.message || error).slice(0, 60000),
              durationMs,
              logId,
            ]
          );
        } catch (logError) {
          console.error(
            '❌ Failed to update 5SIM sync log:',
            logError.message || logError
          );
        }
      }

      console.error('❌ 5SIM catalog sync failed:', {
        message: error.message,
        status: error.httpStatus,
        payload: error.providerPayload,
      });

      throw error;
    } finally {
      if (conn) {
        try {
          conn.release();
        } catch (_) {
          // ignore release error
        }
      }
    }
  };
};