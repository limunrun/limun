//! §1.1.7 table(tabularData, properties) — array of objects -> aligned
//! box-drawn table; anything else falls back to a plain log per spec.

use crate::web::console::common::{log_out, stringify};
use crate::web::console::state::GROUP_DEPTH;
use std::collections::HashMap;

pub fn table(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    if args.length() == 0 {
        log_out("undefined");
        return;
    }
    let data = args.get(0);
    let Ok(array) = v8::Local::<v8::Array>::try_from(data) else {
        log_out(&stringify(scope, data));
        return;
    };

    let mut columns: Vec<String> = Vec::new();
    let mut rows: Vec<HashMap<String, String>> = Vec::with_capacity(array.length() as usize);

    for i in 0..array.length() {
        let Some(item) = array.get_index(scope, i) else {
            continue;
        };
        let mut row = HashMap::new();
        if item.is_object() && !item.is_function() {
            let obj = item.to_object(scope).unwrap();
            if let Some(names) = obj.get_own_property_names(scope, Default::default()) {
                for k in 0..names.length() {
                    let Some(key) = names.get_index(scope, k) else {
                        continue;
                    };
                    let key_str = key.to_rust_string_lossy(scope);
                    if !columns.contains(&key_str) {
                        columns.push(key_str.clone());
                    }
                    let value = obj
                        .get(scope, key)
                        .map(|v| stringify(scope, v))
                        .unwrap_or_default();
                    row.insert(key_str, value);
                }
            }
        } else {
            let col = "Values".to_string();
            if !columns.contains(&col) {
                columns.push(col.clone());
            }
            row.insert(col, stringify(scope, item));
        }
        rows.push(row);
    }

    print_table(&columns, &rows);
}

fn print_table(columns: &[String], rows: &[HashMap<String, String>]) {
    let index_header = "(index)".to_string();
    let mut widths: Vec<usize> = std::iter::once(index_header.len())
        .chain(columns.iter().map(|c| c.len()))
        .collect();

    for (i, row) in rows.iter().enumerate() {
        widths[0] = widths[0].max(i.to_string().len());
        for (ci, col) in columns.iter().enumerate() {
            let cell_len = row.get(col).map(|s| s.len()).unwrap_or(0);
            widths[ci + 1] = widths[ci + 1].max(cell_len);
        }
    }

    let border = |l: &str, m: &str, r: &str| {
        let mut s = l.to_string();
        for (i, w) in widths.iter().enumerate() {
            s.push_str(&"─".repeat(w + 2));
            s.push_str(if i + 1 == widths.len() { r } else { m });
        }
        s
    };

    let row_line = |cells: &[String]| {
        let mut s = "│".to_string();
        for (cell, w) in cells.iter().zip(widths.iter()) {
            s.push_str(&format!(" {cell:^w$} "));
            s.push('│');
        }
        s
    };

    let indent = "  ".repeat(GROUP_DEPTH.with(|d| *d.borrow()));

    println!("{indent}{}", border("┌", "┬", "┐"));
    let mut header = vec![index_header];
    header.extend(columns.iter().cloned());
    println!("{indent}{}", row_line(&header));
    println!("{indent}{}", border("├", "┼", "┤"));
    for (i, row) in rows.iter().enumerate() {
        let mut cells = vec![i.to_string()];
        for col in columns {
            cells.push(row.get(col).cloned().unwrap_or_default());
        }
        println!("{indent}{}", row_line(&cells));
    }
    println!("{indent}{}", border("└", "┴", "┘"));
}