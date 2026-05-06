class SceneParser {
  constructor(hexString) {
    const cleanHex = hexString.replace(/\s+/g, "");
    const bytes = new Uint8Array(
        cleanHex.match(/[\da-f]{2}/gi).map((h) => parseInt(h, 16))
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
        let start = j - 1;
        while (start >= 0) {
          const b = this.view.getUint8(start);
          if (b >= 0x20 && b <= 0x7e) start--;
          else break;
        }
        start++;

        if (j - start >= 4) {
          let rawStr = String.fromCharCode(
              ...new Uint8Array(this.buffer, start, j - start)
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
      const nextStr = strings.find((s) => s.start >= i && s.start < i + 4);

      if (nextStr) {
        const str = nextStr.str;

        if (str.startsWith("PART_")) {
          // Если мы закончили читать предыдущий объект — финализируем его
          if (currentEntity) {
            this.finalizeEntity(currentEntity, floatBuffer);
            result.entities.push(currentEntity);
          }
          currentEntity = { type: str, components: [] };
          floatBuffer = []; // Сброс буфера координат для нового объекта
        } else if (
            str.startsWith("EMBED_") ||
            ["Size", "explode", "default"].includes(str)
        ) {
          if (currentEntity && !currentEntity.components.includes(str)) {
            currentEntity.components.push(str);
          }
        } else {
          // Файлы ассетов (модели, звуки) или метаданные
          if (currentEntity && (str.includes(".g3d") || str.includes(".G3D") || str.includes(".wma"))) {
            if (!currentEntity.components.includes(str))
              currentEntity.components.push(str);
          } else if (!result.metadata.includes(str)) {
            result.metadata.push(str);
          }
        }

        i = nextStr.end + 1; // Прыгаем в конец строки
        continue;
      }

      // Если строки нет, читаем следующие 4 байта как Float32
      if (i + 4 <= this.buffer.byteLength) {
        const floatVal = this.view.getFloat32(i, true); // Little-Endian

        if (this.isValidFloat(floatVal)) {
          floatBuffer.push(parseFloat(floatVal.toFixed(4)));
        }
        // Шагаем строго по 4 байта
        i += 4;
      } else {
        i++;
      }
    }

    // Сохраняем самый последний объект файла
    if (currentEntity) {
      this.finalizeEntity(currentEntity, floatBuffer);
      result.entities.push(currentEntity);
    }

    return JSON.stringify(result, null, 2);
  }

  // --- МАГИЯ СТРУКТУРИРОВАНИЯ ---
  finalizeEntity(entity, floats) {
    // 1. Извлекаем локальную позицию (индексы 10, 11, 12)
    if (floats.length >= 13) {
      entity.localPosition = {
        x: floats[10],
        y: floats[11],
        z: floats[12],
      };
    }

    // 2. Извлекаем 3x3 Матрицу вращения (индексы 13 - 21)
    if (floats.length >= 22) {
      entity.rotationMatrix = [
        [floats[13], floats[14], floats[15]],
        [floats[16], floats[17], floats[18]],
        [floats[19], floats[20], floats[21]],
      ];
    }

    // 3. Извлекаем мировую позицию (индексы 22, 23, 24)
    if (floats.length >= 25) {
      entity.worldPosition = {
        x: floats[22],
        y: floats[23],
        z: floats[24],
      };
    }

    // Сохраняем все остальные извлеченные числа в сыром виде,
    // чтобы не потерять настройки компонентов (Size, Embeds)
    entity.rawTransforms = this.groupFloats(floats);
  }

  cleanString(str) {
    const componentMatch = str.match(/(PART_[A-Z_]+|EMBED_[A-Z_]+)/);
    if (componentMatch) return componentMatch[0];

    // Добавлена поддержка .wma для аудио-ассетов
    const pathMatch = str.match(/[a-zA-Z0-9_\\]+\.([gG]3[dD]|wma)/);
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

    const clean = str.replace(/^.*?([A-Za-z][a-z]+|[a-z]{4,})/, "$1");
    return clean.length >= 4 ? clean : null;
  }

  isValidFloat(val) {
    if (Number.isNaN(val) || !Number.isFinite(val)) return false;
    if (val === 0 || val === 1 || val === -1) return true;
    const absVal = Math.abs(val);
    return absVal > 0.001 && absVal < 10000;
  }

  groupFloats(floats) {
    const grouped = [];
    for (let i = 0; i < floats.length; i += 3) {
      const vec = floats.slice(i, i + 3);
      if (vec.length === 3) {
        if (vec[0] !== 0 || vec[1] !== 0 || vec[2] !== 0) {
          grouped.push(vec);
        }
      }
    }
    return grouped;
  }
}

// Запуск парсера
const hexData = `936E5244 0000803F...`; // Вставляй свой дамп сюда
const parser = new SceneParser(hexData);
console.log(parser.parse());