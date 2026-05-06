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
              ...new Uint8Array(this.buffer, start, j - start),
          );
          let cleanStr = this.cleanString(rawStr);
          if (cleanStr) {
            strings.push({ start, end: j, str: cleanStr });
          }
        }
      }
    }

    let currentEntity = null;
    let currentComponent = null; // Отслеживаем, к какому компоненту относятся числа
    let i = 0;

    while (i < this.buffer.byteLength) {
      const nextStr = strings.find((s) => s.start >= i && s.start < i + 4);

      if (nextStr) {
        const str = nextStr.str;

        if (str.startsWith("PART_")) {
          // Если начинается новый объект — финализируем старый
          if (currentEntity) {
            this.finalizeEntity(currentEntity);
            result.entities.push(currentEntity);
          }
          currentEntity = {
            type: str,
            components: [],
            componentData: { "Transform": [] } // Базовые координаты всегда идут первыми
          };
          currentComponent = "Transform";
        } else if (
            str.startsWith("EMBED_") ||
            ["Size", "explode", "default"].includes(str)
        ) {
          if (currentEntity) {
            if (!currentEntity.components.includes(str)) {
              currentEntity.components.push(str);
            }
            // Переключаем активный компонент
            currentComponent = str;
            if (!currentEntity.componentData[currentComponent]) {
              currentEntity.componentData[currentComponent] = [];
            }
          }
        } else {
          if (currentEntity && (str.includes(".g3d") || str.includes(".G3D") || str.includes(".wma"))) {
            if (!currentEntity.components.includes(str))
              currentEntity.components.push(str);
          } else if (!result.metadata.includes(str)) {
            result.metadata.push(str);
          }
        }

        i = nextStr.end + 1;
        continue;
      }

      if (i + 4 <= this.buffer.byteLength) {
        const floatVal = this.view.getFloat32(i, true);

        // Если число валидно, записываем его в массив текущего активного компонента
        if (this.isValidFloat(floatVal) && currentEntity && currentComponent) {
          currentEntity.componentData[currentComponent].push(parseFloat(floatVal.toFixed(4)));
        }
        i += 4;
      } else {
        i++;
      }
    }

    if (currentEntity) {
      this.finalizeEntity(currentEntity);
      result.entities.push(currentEntity);
    }

    return JSON.stringify(result, null, 2);
  }

  // Здесь происходит магия распределения данных
  finalizeEntity(entity) {
    const tFloats = entity.componentData["Transform"] || [];

    // Константа масштаба (1 к 10)
    const SCALE_FACTOR = 10.0;

    if (tFloats.length >= 13) {
      // Вернули Y и Z, убрали минус (теперь Y-up корректный)
      // И делим на 10 для масштаба
      entity.localPosition = {
        x: tFloats[10] / SCALE_FACTOR,
        y: tFloats[12] / SCALE_FACTOR,
        z: tFloats[11] / SCALE_FACTOR
      };
    }

    if (tFloats.length >= 22) {
      // Свапаем матрицу поворота под новые оси (меняем Y и Z)
      entity.rotationMatrix = [
        [tFloats[13], tFloats[15], tFloats[14]], // 1-я строка (поменяли 2 и 3 колонки)
        [tFloats[19], tFloats[21], tFloats[20]], // 2-я строка (это бывшая 3-я строка, колонки 2 и 3 поменяны)
        [tFloats[16], tFloats[18], tFloats[17]], // 3-я строка (это бывшая 2-я строка, колонки 2 и 3 поменяны)
      ];
    }

    if (tFloats.length >= 25) {
      // Аналогично для мировых координат
      entity.worldPosition = {
        x: tFloats[22] / SCALE_FACTOR,
        y: tFloats[24] / SCALE_FACTOR,
        z: tFloats[23] / SCALE_FACTOR
      };
    }

    // Достаем Scale как отдельное поле
    if (entity.componentData["Size"] && entity.componentData["Size"].length > 0) {
      entity.scale = entity.componentData["Size"];
    }

    // Вытягиваем физическую длину из EMBED_RESIZEROTATE
    // Длина — это 6-й элемент (индекс 5)
    if (entity.componentData["EMBED_RESIZEROTATE"] && entity.componentData["EMBED_RESIZEROTATE"].length >= 6) {
      entity.scaleEmbed = entity.componentData["EMBED_RESIZEROTATE"][5] / 100;
    }
    // На случай, если RESIZEROTATE нет, но есть обычный EMBED_RESIZE
    else if (entity.componentData["EMBED_RESIZE"] && entity.componentData["EMBED_RESIZE"].length >= 8) {
      // В обычном RESIZE индекс может отличаться, но часто это тоже 8-й или 13-й флоат
      // В вашем дампе для PART_LOG в EMBED_RESIZE значение 19.99 стоит на 13-й позиции (индекс 12)
      if (entity.componentData["EMBED_RESIZE"][12]) {
        entity.scaleEmbed = entity.componentData["EMBED_RESIZE"][12] / 100;
      }
    }

    // Сохраняем сырые данные всех компонентов (в виде плоских массивов)
    entity.rawComponents = entity.componentData;
    delete entity.componentData;
  }

  cleanString(str) {
    const componentMatch = str.match(/(PART_[A-Z_]+|EMBED_[A-Z_]+)/);
    if (componentMatch) return componentMatch[0];

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
}

// Запуск парсера
const hexData = `936E5244 0000803F...`; // Вставить дамп
const parser = new SceneParser(hexData);
console.log(parser.parse());