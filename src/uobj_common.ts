export type change_info = {
    by: string;
    on: Date;
};

// The only parts of value_change_item we actually need
export type value_change_item<T> = {
    val: T,
    effective: Date;
}

export const INVALID_DATETIME = new Date("0001-01-01T00:00:00.000Z");
export const INVALID_IND = -1;


export function find_value_change_item<T>(items:value_change_item<T> [], effective: Date, start_ind_reverse: number = INVALID_IND)
{
    if (start_ind_reverse >= 0 && start_ind_reverse < items.length) start_ind_reverse = items.length - 1;
    for (let ind = start_ind_reverse; ind >= 0 && ind < items.length; --ind) {
        if (items[ind].effective <= effective) {
            return ind;
        }
    }
    return INVALID_IND;
}

export function is_active(archived_on: Date): boolean {
    return archived_on.getTime() <= INVALID_DATETIME.getTime();
}

