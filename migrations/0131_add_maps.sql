CREATE TABLE IF NOT EXISTS maps_places (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_norm TEXT NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  kind TEXT NOT NULL DEFAULT 'city',
  city_id TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_maps_places_name_norm ON maps_places(name_norm);
CREATE INDEX IF NOT EXISTS idx_maps_places_city_id ON maps_places(city_id);

INSERT OR IGNORE INTO maps_places (id, name, name_norm, lat, lon, kind, city_id) VALUES
  ('tokyo', '東京', '東京', 35.6762, 139.6503, 'city', 'tokyo'),
  ('shinjuku', '新宿', '新宿', 35.6905, 139.7000, 'station', 'tokyo'),
  ('shibuya', '渋谷', '渋谷', 35.6595, 139.7005, 'station', 'tokyo'),
  ('ikebukuro', '池袋', '池袋', 35.7290, 139.7100, 'station', 'tokyo'),
  ('shinagawa', '品川', '品川', 35.6285, 139.7385, 'station', 'tokyo'),
  ('ueno', '上野', '上野', 35.7137, 139.7730, 'station', 'tokyo'),
  ('akihabara', '秋葉原', '秋葉原', 35.6984, 139.7731, 'station', 'tokyo'),
  ('tokyo-station', '東京駅', '東京駅', 35.6812, 139.7671, 'station', 'tokyo'),
  ('asakusa', '浅草', '浅草', 35.7111, 139.7967, 'landmark', 'tokyo'),
  ('roppongi', '六本木', '六本木', 35.6627, 139.7316, 'landmark', 'tokyo'),
  ('shimokitazawa', '下北沢', '下北沢', 35.6612, 139.6689, 'station', 'tokyo'),
  ('harajuku', '原宿', '原宿', 35.6702, 139.7022, 'station', 'tokyo'),
  ('oosaka', '大阪', '大阪', 34.6937, 135.5023, 'city', 'osaka'),
  ('osaka-station', '大阪駅', '大阪駅', 34.7025, 135.4958, 'station', 'osaka'),
  ('umeda', '梅田', '梅田', 34.7050, 135.4910, 'station', 'osaka'),
  ('shinsaibashi', '心斎橋', '心斎橋', 34.6751, 135.5006, 'landmark', 'osaka'),
  ('namba', 'なんば', 'なんば', 34.6625, 135.5010, 'station', 'osaka'),
  ('tennoji', '天王寺', '天王寺', 34.6486, 135.5148, 'station', 'osaka'),
  ('shinsekai', '新世界', '新世界', 34.6524, 135.5066, 'landmark', 'osaka'),
  ('osaka-castle', '大阪城', '大阪城', 34.6873, 135.5262, 'landmark', 'osaka'),
  ('nagoya', '名古屋', '名古屋', 35.1812, 136.9064, 'city', 'nagoya'),
  ('nagoya-station', '名古屋駅', '名古屋駅', 35.1706, 136.8816, 'station', 'nagoya'),
  ('sakae', '栄', '栄', 35.1718, 136.9110, 'landmark', 'nagoya'),
  ('osu', '大須', '大須', 35.1580, 136.9010, 'landmark', 'nagoya'),
  ('nagoya-castle', '名古屋城', '名古屋城', 35.1850, 136.8990, 'landmark', 'nagoya'),
  ('kanayama', '金山', '金山', 35.1437, 136.9021, 'station', 'nagoya');
