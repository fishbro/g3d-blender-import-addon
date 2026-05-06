class SceneParser {
  constructor(hexString) {
    const cleanHex = hexString.replace(/\s+/g, "");
    const bytes = new Uint8Array(
      cleanHex.match(/[\da-f]{2}/gi).map((h) => parseInt(h, 16)),
    );
    this.buffer = bytes.buffer;
    this.view = new DataView(this.buffer);
  }

  parse() {
    const result = {
      metadata: [],
      entities: [],
    };

    // --- ПРОХОД 1: Ищем и очищаем все строки ---
    const strings = [];
    for (let j = 0; j < this.buffer.byteLength; j++) {
      if (this.view.getUint8(j) === 0x0a) {
        // Ищем символ переноса (\n)
        let start = j - 1;
        while (start >= 0) {
          const b = this.view.getUint8(start);
          if (b >= 0x20 && b <= 0x7e)
            start--; // Читаемые ASCII
          else break;
        }
        start++;

        if (j - start >= 4) {
          let rawStr = String.fromCharCode(
            ...new Uint8Array(this.buffer, start, j - start),
          );
          let cleanStr = this.cleanString(rawStr);
          if (cleanStr) {
            strings.push({ start, end: j, str: cleanStr });
          }
        }
      }
    }

    // --- ПРОХОД 2: Читаем структуру блоков ---
    let currentEntity = null;
    let floatBuffer = [];
    let i = 0;

    while (i < this.buffer.byteLength) {
      // Проверяем, не наткнулись ли мы на строку (с учетом возможных смещений)
      const nextStr = strings.find((s) => s.start >= i && s.start < i + 4);

      if (nextStr) {
        const str = nextStr.str;

        if (str.startsWith("PART_")) {
          if (currentEntity) {
            currentEntity.transforms = this.groupFloats(floatBuffer);
            result.entities.push(currentEntity);
          }
          currentEntity = { type: str, components: [], transforms: [] };
          floatBuffer = []; // Сброс для нового объекта
        } else if (
          str.startsWith("EMBED_") ||
          ["Size", "explode", "default"].includes(str)
        ) {
          if (currentEntity && !currentEntity.components.includes(str)) {
            currentEntity.components.push(str);
          }
        } else {
          // Файлы ассетов или метаданные
          if (currentEntity && (str.includes(".g3d") || str.includes(".G3D"))) {
            if (!currentEntity.components.includes(str))
              currentEntity.components.push(str);
          } else if (!result.metadata.includes(str)) {
            result.metadata.push(str);
          }
        }

        i = nextStr.end + 1; // Прыгаем в конец строки (за пределы 0x0A)
        continue;
      }

      // Если строки нет, читаем следующие 4 байта как Float32
      if (i + 4 <= this.buffer.byteLength) {
        const floatVal = this.view.getFloat32(i, true); // Little-Endian

        if (this.isValidFloat(floatVal)) {
          floatBuffer.push(parseFloat(floatVal.toFixed(4)));
        }
        // ВАЖНО: всегда шагаем по 4 байта, чтобы не сбить выравнивание блоков!
        i += 4;
      } else {
        i++;
      }
    }

    // Сохраняем последний объект
    if (currentEntity) {
      currentEntity.transforms = this.groupFloats(floatBuffer);
      result.entities.push(currentEntity);
    }

    return JSON.stringify(result, null, 2);
  }

  // Жесткий фильтр для мусорных префиксов вроде "L>Shapes" или "Qt>Size"
  cleanString(str) {
    // Проверяем известные игровые паттерны
    const componentMatch = str.match(/(PART_[A-Z_]+|EMBED_[A-Z_]+)/);
    if (componentMatch) return componentMatch[0];

    const pathMatch = str.match(/[a-zA-Z0-9_\\]+\.[gG]3[dD]/);
    if (pathMatch) return pathMatch[0];

    const keywords = [
      "Orbiting Stars",
      "Chris Cole",
      "Size",
      "explode",
      "default",
    ];
    for (let kw of keywords) {
      if (str.includes(kw)) return kw;
    }

    // Если это неизвестная строка, вырезаем мусор в начале до первого нормального слова
    const clean = str.replace(/^.*?([A-Za-z][a-z]+|[a-z]{4,})/, "$1");
    return clean.length >= 4 ? clean : null;
  }

  isValidFloat(val) {
    if (Number.isNaN(val) || !Number.isFinite(val)) return false;
    // 0, 1 и -1 обычно являются частями матриц поворота/масштаба
    if (val === 0 || val === 1 || val === -1) return true;

    const absVal = Math.abs(val);
    // Фильтруем системные Int32 байты (они превратятся в числа вроде 1.4e-45)
    return absVal > 0.001 && absVal < 10000;
  }

  groupFloats(floats) {
    const grouped = [];
    for (let i = 0; i < floats.length; i += 3) {
      const vec = floats.slice(i, i + 3);
      if (vec.length === 3) {
        // Исключаем пустые векторы [0, 0, 0], чтобы оставить только реальные координаты смещения
        if (vec[0] !== 0 || vec[1] !== 0 || vec[2] !== 0) {
          grouped.push(vec);
        }
      }
    }
    return grouped;
  }
}

// Запуск парсера
const hexData = `936E5244 0000803F...`; // <--- Сюда снова вставить дамп
const parser = new SceneParser(hexData);
console.log(parser.parse());
