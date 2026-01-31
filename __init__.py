bl_info = {
    "name": "G3D Import Blender Addon",
    "author": "Fish_Bro",
    "version": (0, 0, 1),
    "blender": (2, 80, 0),
    "location": "File > Import > G3D (.G3D)",
    "description": "Imports G3D models with Deep Scan and Infinity Protection",
    "warning": "",
    "category": "Import-Export",
}

import bpy
import struct
import os
import re
import math
from bpy_extras.io_utils import ImportHelper
from bpy.props import StringProperty, FloatProperty
from bpy.types import Operator

# ==========================================
# НАСТРОЙКИ ФИЛЬТРАЦИИ
# ==========================================

# Максимальное удаление от центра (в метрах/юнитах).
# Все, что дальше, считается мусором.
COORD_LIMIT = 20000.0

# Минимальное значение (для отсева денормализованных чисел/шума), если число не 0
MIN_FLOAT_PRECISION = 1e-6

# ==========================================
# УТИЛИТЫ
# ==========================================

def log(msg):
    print(f"[G3D Import] {msg}")

def find_texture_file(base_dir, tex_name):
    if not tex_name: return None
    clean_name = tex_name.strip('\x00').strip()
    target = os.path.splitext(clean_name)[0].lower()

    for root, dirs, files in os.walk(base_dir):
        for file in files:
            fname, fext = os.path.splitext(file)
            if fext.lower() in ['.bmp', '.png', '.jpg', '.tga', '.dds']:
                if fname.lower() == target:
                    return os.path.join(root, file)
    return None

def create_all_materials(tex_names, base_dir):
    materials = []
    for name in tex_names:
        clean_name = name.strip('\x00').strip()
        if not clean_name: continue

        mat_name = f"Mat_{os.path.splitext(clean_name)[0]}"
        if mat_name in bpy.data.materials:
            materials.append(bpy.data.materials[mat_name])
            continue

        mat = bpy.data.materials.new(name=mat_name)
        mat.use_nodes = True
        materials.append(mat)

        tex_path = find_texture_file(base_dir, clean_name)
        if tex_path:
            try:
                nodes = mat.node_tree.nodes
                links = mat.node_tree.links
                nodes.clear()
                bsdf = nodes.new('ShaderNodeBsdfPrincipled')
                output = nodes.new('ShaderNodeOutputMaterial')
                output.location = (300, 0)
                img_node = nodes.new('ShaderNodeTexImage')
                img_node.location = (-300, 0)
                try:
                    img_node.image = bpy.data.images.load(tex_path)
                    links.new(img_node.outputs['Color'], bsdf.inputs['Base Color'])
                    links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])
                    if tex_path.lower().endswith(('.png', '.tga', '.dds')):
                        try:
                            links.new(img_node.outputs['Alpha'], bsdf.inputs['Alpha'])
                            mat.blend_method = 'HASHED'
                        except: pass
                except: pass
            except Exception as e:
                log(f"Error creating mat {mat_name}: {e}")
    return materials

def get_texture_names(data):
    pattern = rb'[\w-]+\.(?:bmp|jpg|tga|png|dds)'
    matches = re.findall(pattern, data, re.IGNORECASE)
    unique = []
    seen = set()
    for m in matches:
        s = m.decode('utf-8', errors='ignore')
        if s not in seen:
            unique.append(s)
            seen.add(s)
    return unique

def is_valid_coordinate(val):
    """Строгая проверка координаты"""
    if math.isnan(val) or math.isinf(val):
        return False
    # Проверка на "улет в космос"
    if abs(val) > COORD_LIMIT:
        return False
    return True

def process_g3d_file(filepath, context):
    if not os.path.exists(filepath):
        log(f"File not found: {filepath}")
        return {'CANCELLED'}

    base_dir = os.path.dirname(filepath)
    filename = os.path.basename(filepath)

    with open(filepath, 'rb') as f:
        data = f.read()

    tex_names = get_texture_names(data)
    loaded_materials = create_all_materials(tex_names, base_dir)

    if "Collection" in bpy.data.collections:
        col = bpy.data.collections["Collection"]
    else:
        col = context.scene.collection

    root_obj = bpy.data.objects.new(f"{filename}_Root", None)
    col.objects.link(root_obj)

    cursor = 0
    meshes_count = 0
    processed_locs = set()
    data_len = len(data)

    # 32 (Standard), 40 (Rigged?), 24 (Compact), 20, 44
    POSSIBLE_STRIDES = [32, 40, 24, 20, 16, 44, 48, 52]

    while cursor < data_len - 100:
        try:
            v_count = struct.unpack('<I', data[cursor:cursor+4])[0]
        except: break

        # Эвристика: кол-во вершин
        if 3 <= v_count <= 65535:
            found_configuration = None

            # Пропуск заголовков
            for header_skip in [0, 4, 8, 12]:
                v_start = cursor + 4 + header_skip

                # --- FAST FAIL CHECK ---
                # Читаем первую вершину сразу. Если она в "космосе", не тратим время.
                if v_start + 12 > data_len: continue
                try:
                    fx, fy, fz = struct.unpack('<fff', data[v_start:v_start+12])
                    if not (is_valid_coordinate(fx) and is_valid_coordinate(fy) and is_valid_coordinate(fz)):
                        continue
                except: continue

                # Перебор Stride
                for stride in POSSIBLE_STRIDES:
                    v_block_size = v_count * stride

                    # Поиск индексов (Gap Search up to 512 bytes)
                    for padding in range(0, 512, 1):
                        i_off = v_start + v_block_size + padding
                        if i_off + 8 > data_len: break

                        try:
                            i_count = struct.unpack('<I', data[i_off:i_off+4])[0]
                        except: continue

                        # Эвристика: индексы
                        if 3 <= i_count < 200000:
                            idx_start = i_off + 4

                            # Проверяем 16-битные (H)
                            valid_indices = False
                            i_type = 'H'

                            if idx_start + 2*min(6, i_count) <= data_len:
                                try:
                                    # Берем пробную партию индексов
                                    chk_idx = struct.unpack('<' + 'H'*min(6, i_count), data[idx_start:idx_start + min(6, i_count)*2])
                                    # Индекс не может быть больше кол-ва вершин
                                    if all(idx < v_count for idx in chk_idx):
                                        valid_indices = True
                                except: pass

                            if valid_indices:
                                found_configuration = (header_skip, stride, i_count, i_off, 'H')
                                break

                    if found_configuration: break
                if found_configuration: break

            if found_configuration:
                if cursor in processed_locs:
                    cursor += 1
                    continue

                h_skip, stride, i_count, i_off, i_type = found_configuration

                # --- ПРОВЕРКА ГЕОМЕТРИИ НА "БЕСКОНЕЧНОСТЬ" ---
                verts = []
                uvs = []
                vp = cursor + 4 + h_skip
                mesh_is_valid = True

                for _ in range(v_count):
                    try:
                        vx, vy, vz = struct.unpack('<fff', data[vp:vp+12])

                        # ! ВАЖНАЯ ПРОВЕРКА !
                        # Если хотя бы одна точка улетает в бесконечность, дропаем весь меш
                        if not (is_valid_coordinate(vx) and is_valid_coordinate(vy) and is_valid_coordinate(vz)):
                            mesh_is_valid = False
                            break

                        verts.append((-vy, vx, vz))

                        tu, tv = 0.0, 0.0
                        if stride >= 32:
                            tu, tv = struct.unpack('<ff', data[vp+24:vp+32])
                        elif stride >= 20:
                            tu, tv = struct.unpack('<ff', data[vp+12:vp+20])

                        if math.isnan(tu): tu = 0.0
                        if math.isnan(tv): tv = 0.0
                        uvs.append((tu, 1.0 - tv))

                    except:
                        mesh_is_valid = False
                        break

                    vp += stride

                if not mesh_is_valid:
                    # Если меш мусорный, но сигнатура была похожа,
                    # просто сдвигаем курсор на 1 байт и ищем дальше.
                    cursor += 1
                    continue

                # Если прошли проверки, добавляем в список обработанных
                processed_locs.add(cursor)
                log(f"Valid Mesh found at {cursor}: V={v_count} S={stride}")

                # Чтение индексов
                faces = []
                idx_fmt = f'<{i_count}{i_type}'
                idx_size = 2 if i_type == 'H' else 4
                idx_start = i_off + 4

                try:
                    raw_indices = struct.unpack(idx_fmt, data[idx_start:idx_start + i_count * idx_size])
                    for i in range(0, len(raw_indices)-2, 3):
                        v1, v2, v3 = raw_indices[i], raw_indices[i+1], raw_indices[i+2]
                        if v1 < v_count and v2 < v_count and v3 < v_count:
                             faces.append((v1, v2, v3))
                except: pass

                # Создание объекта
                mname = f"Mesh_{meshes_count}_{filename}"
                mesh = bpy.data.meshes.new(mname)
                obj = bpy.data.objects.new(mname, mesh)
                obj.parent = root_obj
                col.objects.link(obj)

                mesh.from_pydata(verts, [], faces)

                if uvs:
                    uv_layer = mesh.uv_layers.new(name="UVMap")
                    for loop in mesh.loops:
                        try:
                            uv_layer.data[loop.index].uv = uvs[loop.vertex_index]
                        except: pass

                if loaded_materials:
                    mat_idx = 0
                    if cursor >= 4:
                        try:
                            pot_idx = struct.unpack('<I', data[cursor-4:cursor])[0]
                            if pot_idx < len(loaded_materials):
                                mat_idx = pot_idx
                        except: pass
                    obj.data.materials.append(loaded_materials[mat_idx % len(loaded_materials)])

                mesh.update()
                meshes_count += 1

                # Прыгаем за конец меша
                cursor = idx_start + (i_count * idx_size)
                continue

        cursor += 1

    log(f"Import finished. Total meshes: {meshes_count}")
    return {'FINISHED'}

class ImportG3D(Operator, ImportHelper):
    """Import G3D"""
    bl_idname = "import_scene.g3d"
    bl_label = "Import G3D (Safe)"
    bl_options = {'PRESET', 'UNDO'}

    filter_glob: StringProperty(default="*.G3D", options={'HIDDEN'})

    # Можно менять лимит прямо в окне импорта
    limit_coordinates: FloatProperty(
        name="Infinity Limit",
        description="Ignore vertices further than this from origin",
        default=20000.0,
    )

    def execute(self, context):
        global COORD_LIMIT
        COORD_LIMIT = self.limit_coordinates
        return process_g3d_file(self.filepath, context)

def menu_func_import(self, context):
    self.layout.operator(ImportG3D.bl_idname, text="G3D (.G3D)")

def register():
    bpy.utils.register_class(ImportG3D)
    bpy.types.TOPBAR_MT_file_import.append(menu_func_import)

def unregister():
    bpy.utils.unregister_class(ImportG3D)
    bpy.types.TOPBAR_MT_file_import.remove(menu_func_import)

if __name__ == "__main__":
    register()
