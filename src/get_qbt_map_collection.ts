import { Collection } from "mongodb";
import { qbt_object_map } from "./types";
import { db } from "./db";


export function get_qbt_map_collection(): Collection<qbt_object_map> {
    return db.collection<qbt_object_map>("qbt_object_map");
}
